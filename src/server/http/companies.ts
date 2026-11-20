import { FIELDS, type FieldName } from '#common/settings.ts'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.ts'
import { auditEvents, contacts } from '../db/schema.ts'
import {
	loadMaster,
	mergeCompanies,
	overrideField,
	unmergeSource,
	type MasterCompany,
} from '../pipeline/resolve/store.ts'
import { invalidRequest, readBody, readQuery } from './read-body.ts'
import { requireUser, type AppEnv } from './session.ts'

const listQuery = z.object({
	q: z.string().trim().max(100).optional(),
	filter: z
		.union([
			z.enum(['conflicts', 'stale', 'duplicates', 'overridden', 'multi-source']),
			z.templateLiteral(['conflict:', z.enum(FIELDS)]),
		])
		.optional(),
})
const idParam = z.coerce.number().int().positive()
const reason = z.string().max(500)
const overrideBody = z.object({ field: z.enum(FIELDS), sourceId: z.number().int().positive(), reason })
const mergeBody = z.object({ otherCompanyId: z.number().int().positive(), reason })
const unmergeBody = z.object({ sourceId: z.number().int().positive(), reason })

const flagged = (company: MasterCompany, flag: 'conflict' | 'stale') =>
	FIELDS.filter((field) => company.fields[field][flag])

function listRow(company: MasterCompany) {
	const { fields } = company
	return {
		id: company.id,
		name: fields.name.value,
		domain: fields.domain.value,
		country: fields.country.value,
		industry: fields.industry.value,
		industryLabel:
			fields.industry.candidates[0]?.value === undefined
				? (company.sources.find((source) => source.industryLabel)?.industryLabel ?? null)
				: null,
		headcount: fields.headcount.value,
		revenueGbp: fields.revenue.value?.gbp ?? null,
		providers: [...new Set(company.sources.map((source) => source.provider))],
		conflicts: flagged(company, 'conflict'),
		stale: flagged(company, 'stale'),
		overridden: FIELDS.filter((field) => company.fields[field].override),
		contactCount: company.contactIds.length,
	}
}

export function companyRoutes(deps: AppDeps) {
	const actorOf = (user: AppEnv['Variables']['user']) => ({ id: user!.id, role: user!.role })

	return new Hono<AppEnv>()
		.get('/companies', requireUser, async (context) => {
			const query = readQuery(context, listQuery)
			if (!query) return invalidRequest(context)
			const master = await loadMaster(deps.db, deps.clock())
			const duplicateIds = new Set(master.possibleDuplicates.flatMap((pair) => pair.companyIds))

			let rows = master.companies
			const filter = query.filter
			if (filter === 'conflicts') rows = rows.filter((company) => flagged(company, 'conflict').length > 0)
			else if (filter === 'stale') rows = rows.filter((company) => flagged(company, 'stale').length > 0)
			else if (filter === 'duplicates') rows = rows.filter((company) => duplicateIds.has(company.id))
			else if (filter === 'overridden')
				rows = rows.filter((company) => FIELDS.some((field) => company.fields[field].override))
			else if (filter === 'multi-source') rows = rows.filter((company) => company.sources.length > 1)
			else if (filter?.startsWith('conflict:')) {
				const field = filter.slice('conflict:'.length) as FieldName
				rows = rows.filter((company) => company.fields[field].conflict)
			}
			if (query.q) {
				const needle = query.q.toLowerCase()
				rows = rows.filter((company) =>
					[
						company.fields.name.value,
						company.fields.domain.value,
						...company.sources.map((source) => source.name),
					].some((value) => value?.toLowerCase().includes(needle)),
				)
			}

			const conflicts = Object.fromEntries(
				FIELDS.map((field) => [field, master.companies.filter((company) => company.fields[field].conflict).length]),
			)
			return context.json({
				companies: rows.map(listRow).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id - b.id),
				summary: {
					companies: master.companies.length,
					sources: master.companies.reduce((sum, company) => sum + company.sources.length, 0),
					conflicts,
					stale: master.companies.filter((company) => flagged(company, 'stale').length > 0).length,
					possibleDuplicates: master.possibleDuplicates.length,
				},
			})
		})
		.get('/companies/:id', requireUser, async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			if (!id.success) return invalidRequest(context)
			const master = await loadMaster(deps.db, deps.clock())
			const company = master.companies.find((candidate) => candidate.id === id.data)
			if (!company) return context.json({ error: 'Company not found' }, 404)

			const names = new Map(master.companies.map((candidate) => [candidate.id, candidate.fields.name.value]))
			const contactRows = company.contactIds.length
				? await deps.db.select().from(contacts).where(inArray(contacts.id, company.contactIds))
				: []
			const activity = await deps.db
				.select()
				.from(auditEvents)
				.where(and(eq(auditEvents.entityType, 'company'), eq(auditEvents.entityId, String(company.id))))
				.orderBy(desc(auditEvents.at), desc(auditEvents.id))

			return context.json({
				company,
				contacts: contactRows
					.map((contact) => ({
						id: contact.id,
						fullName: contact.fullName,
						title: contact.title,
						seniority: contact.seniority,
						functions: contact.functions,
						personKey: contact.personKey,
						emailStatus: contact.emailStatus,
						provider: contact.provider,
						rawRecordId: contact.rawRecordId,
					}))
					.sort((a, b) => (a.fullName ?? '').localeCompare(b.fullName ?? '')),
				possibleDuplicates: master.possibleDuplicates
					.filter((pair) => pair.companyIds.includes(company.id))
					.map((pair) => {
						const otherId = pair.companyIds[0] === company.id ? pair.companyIds[1] : pair.companyIds[0]
						return { companyId: otherId, name: names.get(otherId) ?? null, reason: pair.reason }
					}),
				activity,
			})
		})
		.post('/companies/:id/overrides', requireUser, async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			const body = await readBody(context, overrideBody)
			if (!id.success || !body) return invalidRequest(context)
			const company = await overrideField(deps.db, {
				companyId: id.data,
				field: body.field,
				sourceId: body.sourceId,
				reason: body.reason,
				actor: actorOf(context.var.user),
				requestId: context.var.requestId,
				now: deps.clock(),
			})
			return context.json({ company })
		})
		.post('/companies/:id/merge', requireUser, async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			const body = await readBody(context, mergeBody)
			if (!id.success || !body) return invalidRequest(context)
			const result = await mergeCompanies(deps.db, {
				companyId: id.data,
				otherCompanyId: body.otherCompanyId,
				reason: body.reason,
				actor: actorOf(context.var.user),
				requestId: context.var.requestId,
				now: deps.clock(),
			})
			return context.json(result)
		})
		.post('/companies/:id/unmerge', requireUser, async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			const body = await readBody(context, unmergeBody)
			if (!id.success || !body) return invalidRequest(context)
			const result = await unmergeSource(deps.db, {
				companyId: id.data,
				sourceId: body.sourceId,
				reason: body.reason,
				actor: actorOf(context.var.user),
				requestId: context.var.requestId,
				now: deps.clock(),
			})
			return context.json(result)
		})
}
