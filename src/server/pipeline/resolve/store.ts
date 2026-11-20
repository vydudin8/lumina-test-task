import type { FieldName, ProviderName } from '#common/settings.ts'
import { desc, eq, sql } from 'drizzle-orm'
import { audit } from '../../audit.ts'
import type { Db, Executor } from '../../db/client.ts'
import {
	companies,
	contacts,
	fieldOverrides,
	fxRates,
	matchDecisions,
	rawRecords,
	sourceCompanies,
} from '../../db/schema.ts'
import { DomainError } from '../../lib/errors.ts'
import { personKeyHash } from '../../policy/person-key.ts'
import {
	cluster,
	normaliseContact,
	normaliseSource,
	resolveFields,
	type FxRate,
	type MatchDecision,
	type Override,
	type ResolvedField,
	type ResolvedFields,
	type SourceCompany,
	type SourceFields,
} from './core.ts'

type UserActor = { id: string; role: 'rep' | 'lead' }

const latestRaw = (executor: Executor, kind: 'company' | 'contact') =>
	executor
		.selectDistinctOn([rawRecords.provider, rawRecords.externalId])
		.from(rawRecords)
		.where(eq(rawRecords.kind, kind))
		.orderBy(rawRecords.provider, rawRecords.externalId, desc(rawRecords.fetchedAt), desc(rawRecords.id))

async function loadFx(executor: Executor): Promise<FxRate[]> {
	const rows = await executor.select().from(fxRates)
	return rows.map((row) => ({ id: row.id, currency: row.currency, rate: row.rate, asOf: row.asOf }))
}

async function latestDecisions(executor: Executor): Promise<MatchDecision[]> {
	const rows = await executor
		.selectDistinctOn([matchDecisions.sourceA, matchDecisions.sourceB])
		.from(matchDecisions)
		.orderBy(matchDecisions.sourceA, matchDecisions.sourceB, desc(matchDecisions.at), desc(matchDecisions.id))
	return rows.map((row) => ({ a: row.sourceA, b: row.sourceB, decision: row.decision as MatchDecision['decision'] }))
}

const excluded = (column: string) => sql.raw(`excluded."${column}"`)

// Rebuilds source records from the latest raw data, re-clusters them and links contacts. Deterministic and idempotent.
export async function resolveAll(tx: Executor, now: Date) {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('resolve'))`)
	const fx = await loadFx(tx)

	const companyRows = (await latestRaw(tx, 'company')).map((raw) => {
		const { revenue, ...fields } = normaliseSource(raw.provider as ProviderName, raw.payload, fx)
		return {
			provider: raw.provider,
			externalId: raw.externalId,
			rawRecordId: raw.id,
			fetchedAt: raw.fetchedAt,
			normalisedName: fields.normalisedName,
			normalisedDomain: fields.domain,
			country: fields.country,
			fields,
			revenueAmount: revenue?.amount ?? null,
			revenueCurrency: revenue?.currency ?? null,
			revenueGbp: revenue?.gbp ?? null,
			fxRateId: revenue?.fxRateId ?? null,
		}
	})
	for (let i = 0; i < companyRows.length; i += 500) {
		await tx
			.insert(sourceCompanies)
			.values(companyRows.slice(i, i + 500))
			.onConflictDoUpdate({
				target: [sourceCompanies.provider, sourceCompanies.externalId],
				set: Object.fromEntries(
					[
						'raw_record_id',
						'fetched_at',
						'normalised_name',
						'normalised_domain',
						'country',
						'fields',
						'revenue_amount',
						'revenue_currency',
						'revenue_gbp',
						'fx_rate_id',
					].map((column) => [column.replace(/_(\w)/g, (_, letter: string) => letter.toUpperCase()), excluded(column)]),
				),
			})
	}

	const sources = await tx.select().from(sourceCompanies).orderBy(sourceCompanies.id)
	const { groups } = cluster(
		sources.map((source) => ({
			id: source.id,
			normalisedName: source.normalisedName,
			domain: source.normalisedDomain,
			country: source.country,
		})),
		await latestDecisions(tx),
	)

	// Each group keeps the company id most of its records already carry; the larger part of a split keeps the id.
	const current = new Map(sources.map((source) => [source.id, source.companyId]))
	const votes = groups.flatMap((group, index) => {
		const counts = new Map<number, number>()
		for (const id of group) {
			const companyId = current.get(id)
			if (companyId) counts.set(companyId, (counts.get(companyId) ?? 0) + 1)
		}
		return [...counts].map(([companyId, count]) => ({ index, companyId, count, first: group[0]! }))
	})
	votes.sort((a, b) => b.count - a.count || a.first - b.first || a.companyId - b.companyId)
	const groupCompany = new Map<number, number>()
	const claimed = new Set<number>()
	for (const vote of votes) {
		if (groupCompany.has(vote.index) || claimed.has(vote.companyId)) continue
		groupCompany.set(vote.index, vote.companyId)
		claimed.add(vote.companyId)
	}
	const unassigned = groups.map((_, index) => index).filter((index) => !groupCompany.has(index))
	if (unassigned.length) {
		const created = await tx
			.insert(companies)
			.values(unassigned.map(() => ({ createdAt: now })))
			.returning({ id: companies.id })
		unassigned.forEach((index, i) => groupCompany.set(index, created[i]!.id))
	}
	for (const [index, group] of groups.entries()) {
		const companyId = groupCompany.get(index)!
		for (const id of group) {
			if (current.get(id) !== companyId)
				await tx.update(sourceCompanies).set({ companyId }).where(eq(sourceCompanies.id, id))
		}
	}

	// Contacts link to their provider's own company record: Apollo by organization id, FactSet by fsym_id, Clay by domain.
	const sourceByRef = new Map(
		sources.map((source) => [
			`${source.provider}|${source.provider === 'clay' ? source.normalisedDomain : source.externalId}`,
			source.id,
		]),
	)
	const contactRows = (await latestRaw(tx, 'contact')).map((raw) => {
		const { companyRef, ...fields } = normaliseContact(raw.provider as ProviderName, raw.payload)
		return {
			provider: raw.provider,
			externalId: raw.externalId,
			rawRecordId: raw.id,
			sourceCompanyId: companyRef ? (sourceByRef.get(`${raw.provider}|${companyRef}`) ?? null) : null,
			fetchedAt: raw.fetchedAt,
			personKeyHash: personKeyHash(fields.personKey),
			...fields,
		}
	})
	for (let i = 0; i < contactRows.length; i += 500) {
		await tx
			.insert(contacts)
			.values(contactRows.slice(i, i + 500))
			.onConflictDoUpdate({
				target: [contacts.provider, contacts.externalId],
				set: Object.fromEntries(
					[
						'raw_record_id',
						'source_company_id',
						'person_key',
						'person_key_hash',
						'first_name',
						'last_name',
						'full_name',
						'title',
						'seniority',
						'functions',
						'email_status',
						'fetched_at',
					].map((column) => [column.replace(/_(\w)/g, (_, letter: string) => letter.toUpperCase()), excluded(column)]),
				),
			})
	}

	return { sources: sources.length, companies: groups.length, contacts: contactRows.length }
}

export interface MasterCompany {
	id: number
	sources: SourceCompany[]
	fields: ResolvedFields
	contactIds: number[]
}

export interface MasterDuplicate {
	companyIds: [number, number]
	sourceIds: [number, number]
	reason: string
}

// The whole master, resolved in memory: a few hundred records, and no cached copy that could go stale.
export async function loadMaster(executor: Executor, now: Date) {
	const rows = await executor
		.select()
		.from(sourceCompanies)
		.leftJoin(fxRates, eq(sourceCompanies.fxRateId, fxRates.id))
		.orderBy(sourceCompanies.id)
	const sources = rows.map(({ source_companies: row, fx_rates: fx }) => ({
		...(row.fields as unknown as Omit<SourceFields, 'revenue'>),
		id: row.id,
		companyId: row.companyId!,
		provider: row.provider as ProviderName,
		externalId: row.externalId,
		rawRecordId: row.rawRecordId,
		fetchedAt: row.fetchedAt.toISOString(),
		revenue:
			row.revenueGbp && fx
				? {
						amount: row.revenueAmount!,
						currency: row.revenueCurrency!,
						gbp: row.revenueGbp,
						fxRateId: fx.id,
						rate: fx.rate,
						rateAsOf: fx.asOf,
					}
				: null,
	}))
	const overrides: Override[] = (await executor.select().from(fieldOverrides)).map((row) => ({
		field: row.field,
		chosenSourceId: row.chosenSourceId,
		createdBy: row.createdBy,
		reason: row.reason,
		at: row.at.toISOString(),
	}))
	const contactRows = await executor
		.select({ id: contacts.id, sourceCompanyId: contacts.sourceCompanyId })
		.from(contacts)

	const byCompany = new Map<number, (SourceCompany & { companyId: number })[]>()
	for (const source of sources) byCompany.set(source.companyId, [...(byCompany.get(source.companyId) ?? []), source])
	const companyOfSource = new Map(sources.map((source) => [source.id, source.companyId]))

	const master: MasterCompany[] = [...byCompany].map(([id, members]) => {
		const ids = new Set(members.map((member) => member.id))
		return {
			id,
			sources: members,
			fields: resolveFields(
				members,
				overrides.filter((override) => ids.has(override.chosenSourceId)),
				now,
			),
			contactIds: contactRows
				.filter((contact) => contact.sourceCompanyId !== null && ids.has(contact.sourceCompanyId))
				.map((contact) => contact.id),
		}
	})

	const { possibleDuplicates } = cluster(
		sources.map((source) => ({
			id: source.id,
			normalisedName: source.normalisedName,
			domain: source.domain,
			country: source.country,
		})),
		await latestDecisions(executor),
	)
	const duplicates = new Map<string, MasterDuplicate>()
	for (const pair of possibleDuplicates) {
		const [x, y] = [companyOfSource.get(pair.a)!, companyOfSource.get(pair.b)!]
		if (x === y) continue
		const key = `${Math.min(x, y)}:${Math.max(x, y)}`
		if (!duplicates.has(key))
			duplicates.set(key, {
				companyIds: [Math.min(x, y), Math.max(x, y)],
				sourceIds: [pair.a, pair.b],
				reason: pair.reason,
			})
	}

	return { companies: master.sort((a, b) => a.id - b.id), possibleDuplicates: [...duplicates.values()] }
}

function requireReason(reason: string) {
	if (!reason.trim()) throw new DomainError('Please give a reason. It is saved in the audit log.')
	return reason.trim()
}

async function findCompany(executor: Executor, companyId: number, now: Date) {
	const company = (await loadMaster(executor, now)).companies.find((candidate) => candidate.id === companyId)
	if (!company) throw new DomainError('Company not found.', 404)
	return company
}

const summary = (field: ResolvedField<unknown>) => ({
	value: field.value,
	provider: field.provider,
	sourceId: field.sourceId,
})
const recordLabel = (source: SourceCompany) => `${source.provider}:${source.externalId}`

export async function overrideField(
	db: Db,
	input: {
		companyId: number
		field: FieldName
		sourceId: number
		reason: string
		actor: UserActor
		requestId?: string
		now: Date
	},
) {
	const reason = requireReason(input.reason)
	if (input.field === 'signals')
		throw new DomainError('Signals are combined from every provider, so there is nothing to choose between.')

	return db.transaction(async (tx) => {
		const before = await findCompany(tx, input.companyId, input.now)
		if (!before.fields[input.field].candidates.some((candidate) => candidate.sourceId === input.sourceId)) {
			throw new DomainError('That source record does not belong to this company or has no value for this field.')
		}
		await tx.insert(fieldOverrides).values({
			companyId: input.companyId,
			field: input.field,
			chosenSourceId: input.sourceId,
			createdBy: input.actor.id,
			reason,
			at: input.now,
		})
		const after = await findCompany(tx, input.companyId, input.now)
		await audit(tx, {
			actor: input.actor,
			action: 'field.overridden',
			entityType: 'company',
			entityId: input.companyId,
			decision: 'overridden',
			reason,
			before: { [input.field]: summary(before.fields[input.field]) },
			after: { [input.field]: summary(after.fields[input.field]) },
			result: { chosenSourceId: input.sourceId },
			requestId: input.requestId,
		})
		return after
	})
}

export async function mergeCompanies(
	db: Db,
	input: { companyId: number; otherCompanyId: number; reason: string; actor: UserActor; requestId?: string; now: Date },
) {
	const reason = requireReason(input.reason)
	if (input.companyId === input.otherCompanyId) throw new DomainError('Pick a different company to merge with.')

	return db.transaction(async (tx) => {
		const a = await findCompany(tx, input.companyId, input.now)
		const b = await findCompany(tx, input.otherCompanyId, input.now)
		const [low, high] = [a.sources[0]!.id, b.sources[0]!.id].sort((x, y) => x - y) as [number, number]
		await tx
			.insert(matchDecisions)
			.values({ sourceA: low, sourceB: high, decision: 'merge', reason, createdBy: input.actor.id, at: input.now })
		await resolveAll(tx, input.now)

		const [merged] = await tx
			.select({ companyId: sourceCompanies.companyId })
			.from(sourceCompanies)
			.where(eq(sourceCompanies.id, low))
		const companyId = merged!.companyId!
		await audit(tx, {
			actor: input.actor,
			action: 'company.merged',
			entityType: 'company',
			entityId: companyId,
			reason,
			before: { companies: [a.id, b.id] },
			after: { company: companyId },
			result: { records: [...a.sources, ...b.sources].map(recordLabel) },
			requestId: input.requestId,
		})
		return { companyId }
	})
}

export async function unmergeSource(
	db: Db,
	input: { companyId: number; sourceId: number; reason: string; actor: UserActor; requestId?: string; now: Date },
) {
	const reason = requireReason(input.reason)

	return db.transaction(async (tx) => {
		const company = await findCompany(tx, input.companyId, input.now)
		const source = company.sources.find((candidate) => candidate.id === input.sourceId)
		if (!source) throw new DomainError('That source record does not belong to this company.')
		if (company.sources.length < 2)
			throw new DomainError('This company has only one source record, so there is nothing to split off.')

		const others = company.sources.filter((candidate) => candidate.id !== input.sourceId)
		await tx.insert(matchDecisions).values(
			others.map((other) => ({
				sourceA: Math.min(other.id, source.id),
				sourceB: Math.max(other.id, source.id),
				decision: 'split',
				reason,
				createdBy: input.actor.id,
				at: input.now,
			})),
		)
		await resolveAll(tx, input.now)

		const links = await tx
			.select({ id: sourceCompanies.id, companyId: sourceCompanies.companyId })
			.from(sourceCompanies)
		const companyOf = (id: number) => links.find((link) => link.id === id)!.companyId!
		const splitOff = companyOf(source.id)
		await audit(tx, {
			actor: input.actor,
			action: 'company.unmerged',
			entityType: 'company',
			entityId: company.id,
			reason,
			before: { company: company.id, records: company.sources.map(recordLabel) },
			after: { companies: [companyOf(others[0]!.id), splitOff] },
			result: { record: recordLabel(source), company: splitOff },
			requestId: input.requestId,
		})
		return { companyId: splitOff }
	})
}
