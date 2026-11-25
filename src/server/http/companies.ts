import { FIELDS, PROVIDERS, type FieldName } from '#common/settings.ts'
import { and, asc, count, eq, gt, gte, inArray, lte, or, sql, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.ts'
import { companyDuplicates, companyProfiles, contacts } from '../db/schema.ts'
import { staleBefore } from '../pipeline/resolve/core.ts'
import {
	companyActivity,
	loadCompany,
	mergeCompanies,
	mergedInto,
	overrideField,
	undoMerge,
	unmergeSource,
} from '../pipeline/resolve/store.ts'
import { cursorParam, decodeCursor, toPage } from './keyset.ts'
import { invalidRequest, readBody, readQuery } from './read-body.ts'
import { requireUser, type AppEnv } from './session.ts'

// Multi-value filters travel as comma-separated lists: ?country=GB,IE
const csv = <T extends z.ZodType<unknown, string>>(item: T) =>
	z
		.string()
		.max(1000)
		.transform((value) => value.split(',').filter(Boolean))
		.pipe(z.array(item).max(50))
		.optional()
const decimal = z.string().regex(/^\d+(\.\d+)?$/)
const SORTS = ['name', 'country', 'industry', 'headcount', 'revenue', 'sources', 'flags'] as const
type Sort = (typeof SORTS)[number]
const NUMERIC_SORTS: Sort[] = ['headcount', 'sources', 'flags']
// Sorts whose value can be unknown; the others always have one.
const NULLABLE_SORTS: Sort[] = ['name', 'country', 'industry', 'headcount', 'revenue']

const listQuery = z.object({
	q: z.string().trim().max(100).optional(),
	filter: z
		.union([
			z.enum(['conflicts', 'stale', 'duplicates', 'overridden', 'multi-source']),
			z.templateLiteral(['conflict:', z.enum(FIELDS)]),
		])
		.optional(),
	country: csv(z.string().length(2)),
	industry: csv(z.string().min(1).max(100)),
	source: csv(z.enum(PROVIDERS)),
	headcountMin: z.coerce.number().int().min(0).optional(),
	headcountMax: z.coerce.number().int().min(0).optional(),
	revenueMin: decimal.optional(),
	revenueMax: decimal.optional(),
	sort: z.enum(SORTS).default('name'),
	dir: z.enum(['asc', 'desc']).default('asc'),
	cursor: cursorParam,
})
const PAGE_SIZE = 20
type SortKey = string | number | null
const cursorKey = z.tuple([z.union([z.string().max(300), z.number(), z.null()]), z.number().int()])
const idParam = z.coerce.number().int().positive()
const reason = z.string().max(500)
const overrideBody = z.object({ field: z.enum(FIELDS), sourceId: z.number().int().positive(), reason })
const mergeBody = z.object({ otherCompanyId: z.number().int().positive(), reason })
const unmergeBody = z.object({ sourceId: z.number().int().positive(), reason })
const undoMergeBody = z.object({ mergeEventId: z.number().int().positive(), reason })

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

// A cursor must carry the kind of key its sort compares, or SQL would fail to compare it.
const keyFits = (key: SortKey, sort: Sort) =>
	key === null ||
	((NUMERIC_SORTS.includes(sort) ? typeof key === 'number' : typeof key === 'string') &&
		(sort !== 'revenue' || decimal.safeParse(key).success))

const p = companyProfiles
const countWhere = (condition: SQL) => sql`count(*) filter (where ${condition})`.mapWith(Number)

// Stale depends on the day, so it is counted from the stored "as of" dates against today's threshold.
// COLLATE "C" compares the dates as the code does, character by character.
const staleCount = (threshold: string) =>
	sql<number>`(SELECT count(*) FROM unnest(${p.fieldAsOf}) AS as_of WHERE as_of COLLATE "C" < ${threshold})::int`

// Each sort matches an index in schema.ts (except flags, which includes today's stale count).
function sortKeyOf(sort: Sort, threshold: string): SQL {
	switch (sort) {
		case 'name':
		case 'country':
		case 'industry':
			return sql`${p[sort]} COLLATE natural_sort`
		case 'headcount':
			return sql`${p.headcount}`
		case 'revenue':
			return sql`${p.revenueGbp}`
		case 'sources':
			return sql`cardinality(${p.providers})`
		case 'flags':
			return sql`cardinality(${p.conflicts}) + cardinality(${p.overridden}) + ${staleCount(threshold)}`
	}
}

const listColumns = {
	id: p.companyId,
	name: p.name,
	domain: p.domain,
	country: p.country,
	industry: p.industry,
	industryLabel: p.industryLabel,
	headcount: p.headcount,
	revenueGbp: p.revenueGbp,
	providers: p.providers,
	conflicts: p.conflicts,
	overridden: p.overridden,
	fieldAsOf: p.fieldAsOf,
	contactCount: p.contactCount,
}

export function companyRoutes(deps: AppDeps) {
	const actorOf = (user: AppEnv['Variables']['user']) => ({ id: user!.id, role: user!.role })

	return new Hono<AppEnv>()
		.get('/companies', requireUser, async (context) => {
			const query = readQuery(context, listQuery)
			if (!query) return invalidRequest(context)
			const after = query.cursor ? decodeCursor(cursorKey, query.cursor) : null
			if (query.cursor && (!after || !keyFits(after[0], query.sort))) return invalidRequest(context)
			const threshold = staleBefore(deps.clock())

			// Within one filter any listed value matches; different filters must all match.
			const { filter, country, industry, source, headcountMin, headcountMax, revenueMin, revenueMax } = query
			const conditions = and(
				filter === 'conflicts' ? sql`cardinality(${p.conflicts}) > 0` : undefined,
				filter === 'stale' ? sql`${staleCount(threshold)} > 0` : undefined,
				filter === 'duplicates'
					? sql`EXISTS (SELECT 1 FROM ${companyDuplicates} WHERE ${companyDuplicates.companyA} = ${p.companyId} OR ${companyDuplicates.companyB} = ${p.companyId})`
					: undefined,
				filter === 'overridden' ? sql`cardinality(${p.overridden}) > 0` : undefined,
				filter === 'multi-source' ? gt(p.sourceCount, 1) : undefined,
				filter?.startsWith('conflict:')
					? sql`${filter.slice('conflict:'.length) as FieldName} = ANY(${p.conflicts})`
					: undefined,
				query.q ? sql`strpos(${p.search}, ${query.q.toLowerCase()}) > 0` : undefined,
				country?.length ? inArray(p.country, country) : undefined,
				industry?.length ? inArray(p.industry, industry) : undefined,
				source?.length ? sql`${p.providers} && ${sql.param(source)}::text[]` : undefined,
				headcountMin === undefined ? undefined : gte(p.headcount, headcountMin),
				headcountMax === undefined ? undefined : lte(p.headcount, headcountMax),
				revenueMin === undefined ? undefined : sql`${p.revenueGbp} >= ${revenueMin}::numeric`,
				revenueMax === undefined ? undefined : sql`${p.revenueGbp} <= ${revenueMax}::numeric`,
			)

			// Unknown values sort last in both directions; the company id breaks ties, so the order is total (keyset
			// needs that). A known key seeks in its index; the unknown ones are read after it, by company id.
			const key = sortKeyOf(query.sort, threshold)
			const fetch = (where: SQL | undefined, limit = PAGE_SIZE + 1) =>
				deps.db
					.select({ ...listColumns, sortKey: sql<SortKey>`${key}` })
					.from(p)
					.where(and(conditions, where))
					.orderBy(sql`${key} ${query.dir === 'asc' ? sql`ASC` : sql`DESC`} NULLS LAST`, asc(p.companyId))
					.limit(limit)
			let rows
			if (!after) rows = await fetch(undefined)
			else if (after[0] === null) rows = await fetch(sql`${key} IS NULL AND ${p.companyId} > ${after[1]}`)
			else {
				const [from, beyond] = query.dir === 'asc' ? [sql`>=`, sql`>`] : [sql`<=`, sql`<`]
				rows = await fetch(
					sql`${key} ${from} ${after[0]} AND (${key} ${beyond} ${after[0]} OR ${p.companyId} > ${after[1]})`,
				)
				if (rows.length <= PAGE_SIZE && NULLABLE_SORTS.includes(query.sort))
					rows.push(...(await fetch(sql`${key} IS NULL`, PAGE_SIZE + 1 - rows.length)))
			}
			const page = toPage(rows, PAGE_SIZE, (row) => [row.sortKey, row.id])

			const conflictCounts = Object.fromEntries(
				FIELDS.map((field) => [field, countWhere(sql`${field} = ANY(${p.conflicts})`)]),
			)
			const [[totals], [summary], [duplicates], countries, industries] = await Promise.all([
				deps.db.select({ total: count() }).from(p).where(conditions),
				deps.db
					.select({
						companies: count(),
						sources: sql<number>`coalesce(sum(${p.sourceCount}), 0)::int`,
						stale: countWhere(sql`${staleCount(threshold)} > 0`),
						...conflictCounts,
					})
					.from(p),
				deps.db.select({ possibleDuplicates: count() }).from(companyDuplicates),
				deps.db.selectDistinct({ value: p.country }).from(p),
				deps.db.selectDistinct({ value: p.industry }).from(p),
			])
			const distinct = (rows: { value: string | null }[]) =>
				rows.flatMap((row) => (row.value === null ? [] : [row.value])).sort(collator.compare)
			return context.json({
				total: totals!.total,
				pageSize: PAGE_SIZE,
				nextCursor: page.nextCursor,
				companies: page.items.map(({ sortKey: _, fieldAsOf, ...row }) => ({
					...row,
					stale: FIELDS.filter((_, index) => fieldAsOf[index] && fieldAsOf[index] < threshold),
				})),
				facets: { countries: distinct(countries), industries: distinct(industries) },
				summary: {
					companies: summary!.companies,
					sources: summary!.sources,
					conflicts: Object.fromEntries(FIELDS.map((field) => [field, (summary as Record<string, number>)[field]])),
					stale: summary!.stale,
					possibleDuplicates: duplicates!.possibleDuplicates,
				},
			})
		})
		.get('/companies/:id', requireUser, async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			if (!id.success) return invalidRequest(context)
			const company = await loadCompany(deps.db, id.data, deps.clock())
			if (!company) {
				// A number merged away leads to the company its records went to. Temporary (307), not 308: an undone merge
				// brings the number back, and browsers cache a permanent redirect.
				const target = await mergedInto(deps.db, id.data)
				return target
					? context.redirect(`/api/companies/${target}`, 307)
					: context.json({ error: 'Company not found' }, 404)
			}

			const contactRows = company.contactIds.length
				? await deps.db.select().from(contacts).where(inArray(contacts.id, company.contactIds))
				: []
			const { activity, undoableMerges } = await companyActivity(deps.db, company)
			const d = companyDuplicates
			const other = sql<number>`CASE WHEN ${d.companyA} = ${company.id} THEN ${d.companyB} ELSE ${d.companyA} END`
			const possibleDuplicates = await deps.db
				.select({ companyId: other, name: p.name, reason: d.reason })
				.from(d)
				.leftJoin(p, eq(p.companyId, other))
				.where(or(eq(d.companyA, company.id), eq(d.companyB, company.id)))
				.orderBy(d.sourceA, d.sourceB)

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
				possibleDuplicates,
				activity,
				undoableMerges,
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
		.post('/companies/:id/undo-merge', requireUser, async (context) => {
			const id = idParam.safeParse(context.req.param('id'))
			const body = await readBody(context, undoMergeBody)
			if (!id.success || !body) return invalidRequest(context)
			const result = await undoMerge(deps.db, {
				companyId: id.data,
				mergeEventId: body.mergeEventId,
				reason: body.reason,
				actor: actorOf(context.var.user),
				requestId: context.var.requestId,
				now: deps.clock(),
			})
			return context.json(result)
		})
}
