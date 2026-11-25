import { icpRulesSchema } from '#common/icp.ts'
import type { FieldName, ProviderName } from '#common/settings.ts'
import { and, count, desc, eq, inArray, isNotNull, sql, type SQLWrapper } from 'drizzle-orm'
import { audit } from '../../audit.ts'
import type { Db, Executor } from '../../db/client.ts'
import {
	auditEvents,
	cards,
	companies,
	companyDuplicates,
	companyProfiles,
	companyScores,
	contacts,
	fieldOverrides,
	fxRates,
	icpVersions,
	matchDecisions,
	rawRecords,
	scoredIcpVersions,
	sourceCompanies,
} from '../../db/schema.ts'
import { DomainError } from '../../lib/errors.ts'
import { personKeyHash } from '../../policy/person-key.ts'
import { scoreCompany } from '../score/core.ts'
import {
	cluster,
	normaliseContact,
	normaliseSource,
	profileOf,
	resolveFields,
	staleBefore,
	withStale,
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

const camel = (column: string) => column.replace(/_(\w)/g, (_, letter: string) => letter.toUpperCase())
// Upsert set and condition: only a row whose values really differ is written, so a pull of unchanged data writes nothing.
const upsertOf = (table: string, columns: string[]) => ({
	set: Object.fromEntries(columns.map((column) => [camel(column), sql.raw(`excluded."${column}"`)])),
	setWhere: sql.raw(
		`(${columns.map((column) => `"${table}"."${column}"`).join(', ')}) IS DISTINCT FROM (${columns.map((column) => `excluded."${column}"`).join(', ')})`,
	),
})
// One array parameter, so a list of any length is a single bind value.
const anyOf = (column: SQLWrapper, ids: number[]) => sql`${column} = ANY(${sql.param(ids)}::int[])`
const BATCH = 500

// Every write to the master's inputs, its profiles or the stored scores holds this lock, so they apply one at a time
// and each reads what the one before it committed.
export const lockMaster = (tx: Executor) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('resolve'))`)

const SOURCE_COLUMNS = [
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
]
const CONTACT_COLUMNS = [
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
]

// After a pull: rebuilds source records from the latest raw data, re-clusters, links contacts and refreshes the
// profiles of every company any of that touched. Deterministic and idempotent: unchanged data writes nothing.
export async function resolveAll(tx: Executor, now: Date) {
	await lockMaster(tx)
	const fx = await loadFx(tx)
	const touched = new Set<number>()

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
	for (let i = 0; i < companyRows.length; i += BATCH) {
		const changed = await tx
			.insert(sourceCompanies)
			.values(companyRows.slice(i, i + BATCH))
			.onConflictDoUpdate({
				target: [sourceCompanies.provider, sourceCompanies.externalId],
				...upsertOf('source_companies', SOURCE_COLUMNS),
			})
			.returning({ companyId: sourceCompanies.companyId })
		for (const row of changed) if (row.companyId) touched.add(row.companyId)
	}

	const clustered = await recluster(tx, now)
	for (const id of clustered.affected) touched.add(id)

	// Contacts link to their provider's own company record: Apollo by organization id, FactSet by fsym_id, Clay by domain.
	const sources = await tx
		.select({
			id: sourceCompanies.id,
			provider: sourceCompanies.provider,
			externalId: sourceCompanies.externalId,
			normalisedDomain: sourceCompanies.normalisedDomain,
			companyId: sourceCompanies.companyId,
		})
		.from(sourceCompanies)
	const sourceByRef = new Map(
		sources.map((source) => [
			`${source.provider}|${source.provider === 'clay' ? source.normalisedDomain : source.externalId}`,
			source.id,
		]),
	)
	const companyOfSource = new Map(sources.map((source) => [source.id, source.companyId]))
	// A contact that moves to another record changes the contact count of the company it left, too.
	const linkedTo = new Map(
		(
			await tx
				.select({
					provider: contacts.provider,
					externalId: contacts.externalId,
					sourceCompanyId: contacts.sourceCompanyId,
				})
				.from(contacts)
		).map((contact) => [`${contact.provider}|${contact.externalId}`, contact.sourceCompanyId]),
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
	for (let i = 0; i < contactRows.length; i += BATCH) {
		const changed = await tx
			.insert(contacts)
			.values(contactRows.slice(i, i + BATCH))
			.onConflictDoUpdate({
				target: [contacts.provider, contacts.externalId],
				...upsertOf('contacts', CONTACT_COLUMNS),
			})
			.returning({
				provider: contacts.provider,
				externalId: contacts.externalId,
				sourceCompanyId: contacts.sourceCompanyId,
			})
		for (const row of changed)
			for (const sourceId of [row.sourceCompanyId, linkedTo.get(`${row.provider}|${row.externalId}`)]) {
				const companyId = sourceId ? companyOfSource.get(sourceId) : null
				if (companyId) touched.add(companyId)
			}
	}

	await refreshProfiles(tx, touched, now)
	return {
		sources: sources.length,
		companies: clustered.companies,
		contacts: contactRows.length,
		refreshed: touched.size,
	}
}

// Re-clusters every source record from its matching columns and the latest decisions, moves the records whose
// company changed and replaces the possible-duplicate pairs. Global on purpose: cluster() is order-dependent, so a
// partial run could disagree with a full one. Returns the companies that gained or lost a record.
async function recluster(tx: Executor, now: Date) {
	const sources = await tx
		.select({
			id: sourceCompanies.id,
			normalisedName: sourceCompanies.normalisedName,
			domain: sourceCompanies.normalisedDomain,
			country: sourceCompanies.country,
			companyId: sourceCompanies.companyId,
		})
		.from(sourceCompanies)
		.orderBy(sourceCompanies.id)
	const { groups, possibleDuplicates } = cluster(sources, await latestDecisions(tx))

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

	const companyOf = new Map(groups.flatMap((group, index) => group.map((id) => [id, groupCompany.get(index)!])))
	const moved = sources.filter((source) => source.companyId !== companyOf.get(source.id))
	if (moved.length)
		await tx.execute(sql`
			UPDATE ${sourceCompanies} SET company_id = moved.company_id
			FROM unnest(${sql.param(moved.map((source) => source.id))}::int[], ${sql.param(moved.map((source) => companyOf.get(source.id)!))}::int[]) AS moved(id, company_id)
			WHERE ${sourceCompanies.id} = moved.id`)
	const affected = new Set(
		moved.flatMap((source) => [companyOf.get(source.id)!, ...(source.companyId ? [source.companyId] : [])]),
	)

	// A number no group kept was merged away: it points to where most of its records went, so links to it still lead
	// somewhere. Whatever pointed to it moves on too, so a pointer is never followed twice. A number a group took back
	// (an undone merge) is live again.
	const kept = new Set(groupCompany.values())
	const went = new Map<number, Map<number, number>>()
	for (const source of sources) {
		if (!source.companyId || kept.has(source.companyId)) continue
		const targets = went.get(source.companyId) ?? new Map<number, number>()
		const target = companyOf.get(source.id)!
		went.set(source.companyId, targets.set(target, (targets.get(target) ?? 0) + 1))
	}
	const retired = [...went].map(([id, targets]) => ({
		id,
		target: [...targets].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]![0],
	}))
	await tx
		.update(companies)
		.set({ mergedInto: null })
		.where(and(anyOf(companies.id, [...kept]), isNotNull(companies.mergedInto)))
	if (retired.length)
		await tx.execute(sql`
			UPDATE ${companies} SET merged_into = retired.target
			FROM unnest(${sql.param(retired.map((row) => row.id))}::int[], ${sql.param(retired.map((row) => row.target))}::int[]) AS retired(id, target)
			WHERE ${companies.id} = retired.id OR ${companies.mergedInto} = retired.id`)

	const duplicates = new Map<string, typeof companyDuplicates.$inferInsert>()
	for (const pair of possibleDuplicates) {
		const [x, y] = [companyOf.get(pair.a)!, companyOf.get(pair.b)!]
		if (x === y) continue
		const key = `${Math.min(x, y)}:${Math.max(x, y)}`
		if (!duplicates.has(key))
			duplicates.set(key, {
				companyA: Math.min(x, y),
				companyB: Math.max(x, y),
				sourceA: pair.a,
				sourceB: pair.b,
				reason: pair.reason,
			})
	}
	await tx.delete(companyDuplicates)
	const pairs = [...duplicates.values()]
	for (let i = 0; i < pairs.length; i += BATCH) await tx.insert(companyDuplicates).values(pairs.slice(i, i + BATCH))

	return { companies: groups.length, affected }
}

// The source records of these companies, with the rate each revenue was converted at, by company and in id order.
async function loadSources(executor: Executor, companyIds: number[]) {
	const rows = await executor
		.select()
		.from(sourceCompanies)
		.leftJoin(fxRates, eq(sourceCompanies.fxRateId, fxRates.id))
		.where(anyOf(sourceCompanies.companyId, companyIds))
		.orderBy(sourceCompanies.id)
	const byCompany = new Map<number, SourceCompany[]>()
	for (const { source_companies: row, fx_rates: fx } of rows) {
		const source: SourceCompany = {
			...(row.fields as unknown as Omit<SourceFields, 'revenue'>),
			id: row.id,
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
		}
		byCompany.set(row.companyId!, [...(byCompany.get(row.companyId!) ?? []), source])
	}
	return byCompany
}

const PROFILE_COLUMNS = [
	'fields',
	'name',
	'domain',
	'country',
	'industry',
	'industry_label',
	'headcount',
	'revenue_gbp',
	'signals',
	'providers',
	'source_count',
	'contact_count',
	'conflicts',
	'overridden',
	'field_as_of',
	'search',
]
const REFRESH_BATCH = 2000

// Re-resolves these companies from their source records, overrides and contacts, writes their profiles (a company
// left with no records loses its profile) and rescores them for every scored ICP version. Call it in the
// transaction of the write that changed them, after lockMaster.
export async function refreshProfiles(tx: Executor, companyIds: Iterable<number>, now: Date) {
	const ids = [...new Set(companyIds)].sort((a, b) => a - b)
	for (let i = 0; i < ids.length; i += REFRESH_BATCH) {
		const batch = ids.slice(i, i + REFRESH_BATCH)
		const byCompany = await loadSources(tx, batch)
		const sourceIds = [...byCompany.values()].flatMap((members) => members.map((member) => member.id))
		const overrides = new Map<number, Override[]>()
		for (const row of await tx.select().from(fieldOverrides).where(anyOf(fieldOverrides.chosenSourceId, sourceIds)))
			overrides.set(row.chosenSourceId, [
				...(overrides.get(row.chosenSourceId) ?? []),
				{
					field: row.field,
					chosenSourceId: row.chosenSourceId,
					createdBy: row.createdBy,
					reason: row.reason,
					at: row.at.toISOString(),
				},
			])
		const contactCounts = new Map(
			(
				await tx
					.select({ sourceId: contacts.sourceCompanyId, n: count() })
					.from(contacts)
					.where(anyOf(contacts.sourceCompanyId, sourceIds))
					.groupBy(contacts.sourceCompanyId)
			).map((row) => [row.sourceId!, row.n]),
		)

		const rows = [...byCompany].map(([companyId, members]) => {
			const fields = withStale(
				resolveFields(
					members,
					members.flatMap((member) => overrides.get(member.id) ?? []),
					now,
				),
				null,
			)
			return {
				companyId,
				fields,
				...profileOf(members, fields),
				contactCount: members.reduce((sum, member) => sum + (contactCounts.get(member.id) ?? 0), 0),
			}
		})
		for (let j = 0; j < rows.length; j += BATCH)
			await tx
				.insert(companyProfiles)
				.values(rows.slice(j, j + BATCH))
				.onConflictDoUpdate({ target: companyProfiles.companyId, ...upsertOf('company_profiles', PROFILE_COLUMNS) })
		const gone = batch.filter((id) => !byCompany.has(id))
		if (gone.length) await tx.delete(companyProfiles).where(anyOf(companyProfiles.companyId, gone))
	}
	await rescore(tx, ids)
}

// Scores of these companies (all profiles when null) for these scored ICP versions (all scored ones by default).
// shortcut: every refresh rescores every scored version, so a big pull costs companies x versions; once versions pile
// up, drop the scores of old versions (and their scored_icp_versions row) so they come back lazily on first read.
export async function rescore(tx: Executor, companyIds: number[] | null, versionIds?: number[]) {
	if (companyIds?.length === 0) return
	const versions = await tx
		.select({ id: icpVersions.id, rules: icpVersions.rules })
		.from(scoredIcpVersions)
		.innerJoin(icpVersions, eq(scoredIcpVersions.icpVersionId, icpVersions.id))
		.where(versionIds ? anyOf(scoredIcpVersions.icpVersionId, versionIds) : undefined)
	if (versions.length === 0) return
	const facts = await tx
		.select({
			companyId: companyProfiles.companyId,
			industry: companyProfiles.industry,
			country: companyProfiles.country,
			headcount: companyProfiles.headcount,
			revenueGbp: companyProfiles.revenueGbp,
			signals: companyProfiles.signals,
		})
		.from(companyProfiles)
		.where(companyIds ? anyOf(companyProfiles.companyId, companyIds) : undefined)
	for (const version of versions) {
		const rules = icpRulesSchema.parse(version.rules)
		const rows = facts.map((company) => {
			const score = scoreCompany(rules, company)
			return {
				icpVersionId: version.id,
				companyId: company.companyId,
				inProfile: score.inProfile,
				score: score.score,
				display: score.display,
				contributions: score.contributions,
				outReasons: score.outReasons,
			}
		})
		for (let i = 0; i < rows.length; i += BATCH)
			await tx
				.insert(companyScores)
				.values(rows.slice(i, i + BATCH))
				.onConflictDoUpdate({
					target: [companyScores.icpVersionId, companyScores.companyId],
					...upsertOf('company_scores', ['in_profile', 'score', 'display', 'contributions', 'out_reasons']),
				})
	}
}

// Every profile and score from scratch: for seeds, for databases that predate company_profiles, and after a change
// to the resolution rules.
export async function rebuildAllProfiles(tx: Executor, now: Date) {
	await lockMaster(tx)
	await recluster(tx, now)
	await tx.delete(companyProfiles)
	const ids = await tx.selectDistinct({ id: sourceCompanies.companyId }).from(sourceCompanies)
	await refreshProfiles(
		tx,
		ids.map((row) => row.id!),
		now,
	)
}

// Run at start-up (seed/main.ts): a database migrated from before company_profiles has records but no profiles yet.
export async function ensureProfiles(db: Db, now: Date) {
	const {
		rows: [state],
	} = await db.execute<{ missing: boolean }>(
		sql`SELECT EXISTS (SELECT 1 FROM ${sourceCompanies}) AND NOT EXISTS (SELECT 1 FROM ${companyProfiles}) AS missing`,
	)
	if (state?.missing) await db.transaction((tx) => rebuildAllProfiles(tx, now))
}

export interface MasterCompany {
	id: number
	sources: SourceCompany[]
	fields: ResolvedFields
	contactIds: number[]
}

// One company as the screens show it: stored fields with today's stale flags, its source records and contacts.
export async function loadCompany(executor: Executor, companyId: number, now: Date): Promise<MasterCompany | null> {
	const [profile] = await executor
		.select({ fields: companyProfiles.fields })
		.from(companyProfiles)
		.where(eq(companyProfiles.companyId, companyId))
	if (!profile) return null
	const sources = (await loadSources(executor, [companyId])).get(companyId) ?? []
	const contactRows = await executor
		.select({ id: contacts.id })
		.from(contacts)
		.where(
			anyOf(
				contacts.sourceCompanyId,
				sources.map((source) => source.id),
			),
		)
		.orderBy(contacts.id)
	return {
		id: companyId,
		sources,
		fields: withStale(profile.fields, staleBefore(now)),
		contactIds: contactRows.map((row) => row.id),
	}
}

// Resolved fields of several companies, with today's stale flags. Companies without a profile are left out.
export async function profileFields(executor: Executor, companyIds: number[], now: Date) {
	const rows = await executor
		.select({ id: companyProfiles.companyId, fields: companyProfiles.fields })
		.from(companyProfiles)
		.where(anyOf(companyProfiles.companyId, companyIds))
	const threshold = staleBefore(now)
	return new Map(rows.map((row) => [row.id, withStale(row.fields, threshold)]))
}

// Name and domain of several companies; a company merged away has neither.
export async function companyLabels(executor: Executor, companyIds: number[]) {
	const rows = await executor
		.select({ id: companyProfiles.companyId, name: companyProfiles.name, domain: companyProfiles.domain })
		.from(companyProfiles)
		.where(anyOf(companyProfiles.companyId, companyIds))
	return new Map(rows.map((row) => [row.id, row]))
}

// The company a card belongs to now: the one holding its recipient's provider record, wherever merges and splits
// moved it. A card without a recipient stays with its own company, or the company that one was merged into.
export const cardCompany = sql<number>`coalesce(
	(SELECT ${sourceCompanies.companyId} FROM ${sourceCompanies} WHERE ${sourceCompanies.id} = ${cards.sourceCompanyId}),
	(SELECT coalesce(${companies.mergedInto}, ${companies.id}) FROM ${companies} WHERE ${companies.id} = ${cards.companyId})
)`

// Every domain of these companies' records, by company: a merged company keeps one per office.
export async function companyDomains(executor: Executor, companyIds: number[]) {
	const rows = await executor
		.selectDistinct({ companyId: sourceCompanies.companyId, domain: sourceCompanies.normalisedDomain })
		.from(sourceCompanies)
		.where(and(anyOf(sourceCompanies.companyId, companyIds), isNotNull(sourceCompanies.normalisedDomain)))
		.orderBy(sourceCompanies.companyId, sourceCompanies.normalisedDomain)
	const domains = new Map<number, string[]>()
	for (const row of rows) domains.set(row.companyId!, [...(domains.get(row.companyId!) ?? []), row.domain!])
	return domains
}

// The company this number was merged into, for a number whose records all went elsewhere.
export async function mergedInto(executor: Executor, companyId: number) {
	const [row] = await executor
		.select({ mergedInto: companies.mergedInto })
		.from(companies)
		.where(eq(companies.id, companyId))
	return row?.mergedInto ?? null
}

interface MergeSide {
	company: number
	sourceIds: number[]
}

// The two sides of a recorded merge, cut down to the records this company still holds; null unless both sides are
// still here, which is when the merge can be undone. Merges recorded before sides were kept have none.
function mergeSides(result: unknown, company: MasterCompany): [MergeSide, MergeSide] | null {
	const sides = (result as { sides?: MergeSide[] } | null)?.sides
	if (!Array.isArray(sides) || sides.length !== 2) return null
	const here = new Set(company.sources.map((source) => source.id))
	const [x, y] = sides.map((side) => ({
		company: side.company,
		sourceIds: side.sourceIds.filter((id) => here.has(id)),
	}))
	return x!.sourceIds.length && y!.sourceIds.length ? [x!, y!] : null
}

// What happened to this company, newest first. A choice of value belongs to the record it chose and a merge or split
// to the records it moved, so they show wherever those records are now; anything else stays with its number.
// shortcut: scans every company-level event; index result->>'chosenSourceId' if the audit log gets large.
export async function companyActivity(executor: Executor, company: MasterCompany) {
	const ids = sql.param(company.sources.map((source) => String(source.id)))
	const labels = sql.param(company.sources.map(recordLabel))
	const own = eq(auditEvents.entityId, String(company.id))
	const activity = await executor
		.select()
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.entityType, 'company'),
				sql`CASE ${auditEvents.action}
					WHEN 'field.overridden' THEN ${auditEvents.result}->>'chosenSourceId' = ANY(${ids}::text[])
					WHEN 'company.merged' THEN ${own} OR ${auditEvents.result}->'records' ?| ${labels}::text[]
					WHEN 'company.merge_undone' THEN ${own} OR ${auditEvents.result}->'records' ?| ${labels}::text[]
					WHEN 'company.unmerged' THEN ${own} OR ${auditEvents.before}->'records' ?| ${labels}::text[]
					ELSE ${own} END`,
			),
		)
		.orderBy(desc(auditEvents.at), desc(auditEvents.id))
	const undoableMerges = activity
		.filter((event) => event.action === 'company.merged' && mergeSides(event.result, company))
		.map((event) => event.id)
	return { activity, undoableMerges }
}

function requireReason(reason: string) {
	if (!reason.trim()) throw new DomainError('Please give a reason. It is saved in the audit log.')
	return reason.trim()
}

async function findCompany(executor: Executor, companyId: number, now: Date) {
	const company = await loadCompany(executor, companyId, now)
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
		await lockMaster(tx)
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
		await refreshProfiles(tx, [input.companyId], input.now)
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
		await lockMaster(tx)
		const a = await findCompany(tx, input.companyId, input.now)
		const b = await findCompany(tx, input.otherCompanyId, input.now)
		// Every pair, not just one: otherwise the rest of each company hangs on automatic edges, and splitting one record
		// off later would take the others apart.
		await tx.insert(matchDecisions).values(
			a.sources.flatMap((x) =>
				b.sources.map((y) => ({
					sourceA: Math.min(x.id, y.id),
					sourceB: Math.max(x.id, y.id),
					decision: 'merge',
					reason,
					createdBy: input.actor.id,
					at: input.now,
				})),
			),
		)
		// Only the grouping changed, so the raw records are not read again.
		const { affected } = await recluster(tx, input.now)
		await refreshProfiles(tx, [a.id, b.id, ...affected], input.now)

		const records = [...a.sources, ...b.sources]
		const merged = await tx
			.selectDistinct({ companyId: sourceCompanies.companyId })
			.from(sourceCompanies)
			.where(
				anyOf(
					sourceCompanies.id,
					records.map((source) => source.id),
				),
			)
		// Never a merge that quietly leaves records behind.
		if (merged.length !== 1) throw new DomainError('These records could not all be put in one company.', 409)
		const companyId = merged[0]!.companyId!
		await audit(tx, {
			actor: input.actor,
			action: 'company.merged',
			entityType: 'company',
			entityId: companyId,
			reason,
			before: { companies: [a.id, b.id] },
			after: { company: companyId },
			result: {
				records: records.map(recordLabel),
				// Which records came from which company, so the merge can be undone exactly.
				sides: [a, b].map((side) => ({ company: side.id, sourceIds: side.sources.map((source) => source.id) })),
			},
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
		await lockMaster(tx)
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
		// Detached, the record has no vote for this company's id, so the records left behind keep it even in a 1:1 split.
		await tx.update(sourceCompanies).set({ companyId: null }).where(eq(sourceCompanies.id, source.id))
		// Detaching took the record off the books of its company, so that company is refreshed whatever else moved.
		const { affected } = await recluster(tx, input.now)
		await refreshProfiles(tx, [company.id, ...affected], input.now)

		const links = await tx
			.select({ id: sourceCompanies.id, companyId: sourceCompanies.companyId })
			.from(sourceCompanies)
			.where(inArray(sourceCompanies.id, [source.id, others[0]!.id]))
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

// Takes a recorded merge apart again: the records that came from each company go back to it, under its own number,
// and stay apart. Records that joined since go with whichever side the matching puts them on.
export async function undoMerge(
	db: Db,
	input: { companyId: number; mergeEventId: number; reason: string; actor: UserActor; requestId?: string; now: Date },
) {
	const reason = requireReason(input.reason)

	return db.transaction(async (tx) => {
		await lockMaster(tx)
		const company = await findCompany(tx, input.companyId, input.now)
		const [event] = await tx
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.id, input.mergeEventId), eq(auditEvents.action, 'company.merged')))
		const sides = event && mergeSides(event.result, company)
		if (!sides)
			throw new DomainError(
				'This merge cannot be undone here: the records it joined are not both in this company any more.',
				409,
			)

		const [x, y] = sides
		await tx.insert(matchDecisions).values(
			x.sourceIds.flatMap((p) =>
				y.sourceIds.map((q) => ({
					sourceA: Math.min(p, q),
					sourceB: Math.max(p, q),
					decision: 'split',
					reason,
					createdBy: input.actor.id,
					at: input.now,
				})),
			),
		)
		// Each side carries its old number again, and a group keeps the number most of its records carry.
		for (const side of sides)
			await tx.update(sourceCompanies).set({ companyId: side.company }).where(anyOf(sourceCompanies.id, side.sourceIds))
		const { affected } = await recluster(tx, input.now)
		// Records put back by hand count as unmoved in recluster, so their companies are refreshed here.
		await refreshProfiles(tx, [company.id, x.company, y.company, ...affected], input.now)

		const links = await tx
			.select({ id: sourceCompanies.id, companyId: sourceCompanies.companyId })
			.from(sourceCompanies)
			.where(inArray(sourceCompanies.id, [x.sourceIds[0]!, y.sourceIds[0]!]))
		const companyIds = sides.map((side) => links.find((link) => link.id === side.sourceIds[0])!.companyId!)
		const label = new Map(company.sources.map((source) => [source.id, recordLabel(source)]))
		await audit(tx, {
			actor: input.actor,
			action: 'company.merge_undone',
			entityType: 'company',
			entityId: company.id,
			reason,
			before: { company: company.id, records: company.sources.map(recordLabel) },
			after: { companies: companyIds },
			result: { mergeEventId: event.id, records: [...x.sourceIds, ...y.sourceIds].map((id) => label.get(id)!) },
			requestId: input.requestId,
		})
		return { companyIds }
	})
}
