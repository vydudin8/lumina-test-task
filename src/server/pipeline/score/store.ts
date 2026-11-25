import { describeRange, icpRulesSchema, type IcpRule } from '#common/icp.ts'
import { FIELD_LABELS, PROVIDER_LABELS, SIGNAL_LABELS, type ProviderName } from '#common/settings.ts'
import { and, asc, count, desc, eq, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { audit, systemActor } from '../../audit.ts'
import type { Db, Executor } from '../../db/client.ts'
import { companyProfiles, companyScores, icpVersions, scoreRationales, scoredIcpVersions } from '../../db/schema.ts'
import type { Clock } from '../../lib/clock.ts'
import { DomainError } from '../../lib/errors.ts'
import { generateGrounded, type LlmDeps } from '../../llm/generate.ts'
import type { EvidenceItem } from '../../llm/types.ts'
import type { ResolvedFields } from '../resolve/core.ts'
import { lockMaster, rescore } from '../resolve/store.ts'
import { scoreCompany, type CompanyFacts, type Contribution, type Score } from './core.ts'

type UserActor = { id: string; role: 'rep' | 'lead' }

export interface IcpVersion {
	id: number
	rules: IcpRule[]
	createdBy: string
	createdAt: Date
}

const toVersion = (row: typeof icpVersions.$inferSelect): IcpVersion => ({
	...row,
	rules: icpRulesSchema.parse(row.rules),
})

export async function currentIcp(executor: Executor) {
	const [row] = await executor.select().from(icpVersions).orderBy(desc(icpVersions.id)).limit(1)
	if (!row) throw new DomainError('No ICP has been saved yet.', 404)
	return toVersion(row)
}

export async function icpVersion(executor: Executor, id: number | undefined) {
	if (id === undefined) return currentIcp(executor)
	const [row] = await executor.select().from(icpVersions).where(eq(icpVersions.id, id))
	if (!row) throw new DomainError('That ICP version does not exist.', 404)
	return toVersion(row)
}

export const listIcpVersions = (executor: Executor) =>
	executor
		.select({ id: icpVersions.id, createdBy: icpVersions.createdBy, createdAt: icpVersions.createdAt })
		.from(icpVersions)
		.orderBy(desc(icpVersions.id))

// Saving never edits a version: it adds one, and the audit event carries what changed.
export async function saveIcp(db: Db, input: { rules: IcpRule[]; actor: UserActor; requestId?: string; now: Date }) {
	const rules = icpRulesSchema.parse(input.rules)
	return db.transaction(async (tx) => {
		await lockMaster(tx)
		const previous = await currentIcp(tx)
		const [row] = await tx
			.insert(icpVersions)
			.values({ rules, createdBy: input.actor.id, createdAt: input.now })
			.returning()
		await tx.insert(scoredIcpVersions).values({ icpVersionId: row!.id })
		await rescore(tx, null, [row!.id])
		const before = new Map(previous.rules.map((rule) => [rule.id, JSON.stringify(rule)]))
		const after = new Map(rules.map((rule) => [rule.id, JSON.stringify(rule)]))
		await audit(tx, {
			actor: input.actor,
			action: 'icp.saved',
			entityType: 'icp_version',
			entityId: row!.id,
			before: { version: previous.id, rules: previous.rules },
			after: { version: row!.id, rules },
			result: {
				added: [...after.keys()].filter((id) => !before.has(id)),
				removed: [...before.keys()].filter((id) => !after.has(id)),
				changed: [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id)),
			},
			requestId: input.requestId,
		})
		return toVersion(row!)
	})
}

export const factsOf = (company: { fields: ResolvedFields }): CompanyFacts => ({
	industry: company.fields.industry.value,
	country: company.fields.country.value,
	headcount: company.fields.headcount.value,
	revenueGbp: company.fields.revenue.value?.gbp ?? null,
	signals: company.fields.signals.value ?? [],
})

// Saving a version scores it at once; an older one (from before scores were stored) is scored on its first read.
export async function ensureScores(executor: Executor, icpVersionId: number) {
	const [known] = await executor
		.select()
		.from(scoredIcpVersions)
		.where(eq(scoredIcpVersions.icpVersionId, icpVersionId))
	if (known) return
	await executor.transaction(async (tx) => {
		await lockMaster(tx)
		const [added] = await tx.insert(scoredIcpVersions).values({ icpVersionId }).onConflictDoNothing().returning()
		if (added) await rescore(tx, null, [icpVersionId])
	})
}

const s = companyScores
const toScore = (
	row: Pick<typeof s.$inferSelect, 'inProfile' | 'outReasons' | 'score' | 'display' | 'contributions'>,
): Score => ({
	inProfile: row.inProfile,
	outReasons: row.outReasons,
	score: row.score,
	display: row.display,
	contributions: row.contributions,
})
const scoreColumns = {
	inProfile: s.inProfile,
	outReasons: s.outReasons,
	score: s.score,
	display: s.display,
	contributions: s.contributions,
}
// Rank order: highest exact score first, ties by company id (matches the company_scores_ranked index).
export const RANK_ORDER = [sql`${s.score} DESC NULLS LAST`, asc(s.companyId)]

// The best `limit` companies of a version, in rank order.
export async function topRanked(executor: Executor, icpVersionId: number, limit: number) {
	await ensureScores(executor, icpVersionId)
	const rows = await executor
		.select({ companyId: s.companyId, ...scoreColumns })
		.from(s)
		.where(and(eq(s.icpVersionId, icpVersionId), s.inProfile))
		.orderBy(...RANK_ORDER)
		.limit(limit)
	return rows.map((row, index) => ({ rank: index + 1, companyId: row.companyId, score: toScore(row) }))
}

// One company's stored score and its rank (null when out of the profile), or null when it has no profile.
export async function storedScore(executor: Executor, icpVersionId: number, companyId: number) {
	await ensureScores(executor, icpVersionId)
	const [row] = await executor
		.select(scoreColumns)
		.from(s)
		.where(and(eq(s.icpVersionId, icpVersionId), eq(s.companyId, companyId)))
	if (!row) return null
	if (!row.inProfile) return { score: toScore(row), rank: null }
	const [{ ahead }] = (await executor
		.select({ ahead: count() })
		.from(s)
		.where(
			and(
				eq(s.icpVersionId, icpVersionId),
				s.inProfile,
				sql`(${s.score} > ${row.score} OR (${s.score} = ${row.score} AND ${s.companyId} < ${companyId}))`,
			),
		)) as [{ ahead: number }]
	return { score: toScore(row), rank: ahead + 1 }
}

const integer = new Intl.NumberFormat('en-GB')
const pounds = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 })
const day = (value: string | null) => value?.slice(0, 10) ?? null

const FIELD_FOR_RULE: Record<IcpRule['field'], string> = {
	industry: FIELD_LABELS.industry,
	country: FIELD_LABELS.country,
	headcount: FIELD_LABELS.headcount,
	revenueGbp: FIELD_LABELS.revenue,
	signals: FIELD_LABELS.signals,
}

// What a rule asks for, worded like the Needs column on the Scores screen.
function needs(contribution: Contribution) {
	const { field, op, value } = contribution
	if (field === 'headcount')
		return describeRange(value as [number | null, number | null], (count) => integer.format(count))
	if (field === 'revenueGbp')
		return describeRange(value as [string | null, string | null], (gbp) => pounds.format(gbp as unknown as number))
	const values = (value as string[]).map((item) => (field === 'signals' ? (SIGNAL_LABELS[item] ?? item) : item))
	return `${op === 'any' ? 'any of' : 'one of'} ${values.join(', ')}`
}

// Numbered facts the model may use. Values are formatted exactly as people see them, so the guard can match numbers.
export function rationaleEvidence(company: { fields: ResolvedFields }, score: Score, icp: IcpVersion): EvidenceItem[] {
	const { fields } = company
	const items: Omit<EvidenceItem, 'id'>[] = [
		{
			label: 'company',
			value: fields.name.value ?? 'Unnamed company',
			source: fields.name.provider ? PROVIDER_LABELS[fields.name.provider] : 'unknown',
			date: day(fields.name.fetchedAt),
		},
	]
	const add = (
		label: string,
		value: string | null,
		field: { provider: ProviderName | null; asOf: string | null; fetchedAt: string | null },
	) =>
		items.push({
			label,
			value: value ?? 'unknown',
			source: field.provider ? PROVIDER_LABELS[field.provider] : 'no provider',
			date: field.asOf ?? day(field.fetchedAt),
		})
	add('industry', fields.industry.value, fields.industry)
	add('country', fields.country.value, fields.country)
	add('headcount', fields.headcount.value === null ? null : integer.format(fields.headcount.value), fields.headcount)
	add(
		'revenue',
		fields.revenue.value ? pounds.format(fields.revenue.value.gbp as unknown as number) : null,
		fields.revenue,
	)
	items.push({
		label: 'signals',
		value: fields.signals.value?.map((signal) => SIGNAL_LABELS[signal] ?? signal).join('; ') ?? 'none reported',
		source:
			[...new Set(fields.signals.candidates.map((candidate) => PROVIDER_LABELS[candidate.provider]))].join(', ') ||
			'no provider',
		date: null,
	})
	items.push({ label: 'score', value: `${score.display} out of 100`, source: `ICP version ${icp.id}`, date: null })
	const missed = score.contributions.filter((contribution) => contribution.outcome !== 'pass')
	items.push({
		label: 'rules missed',
		value: missed.length
			? missed.map((contribution) => `${contribution.ruleId} (${contribution.outcome})`).join('; ')
			: 'none',
		source: `ICP version ${icp.id}`,
		date: null,
	})
	// Thresholds and points are on screen next to the explanation; without them the guard rejects any line that names one.
	for (const contribution of score.contributions)
		items.push({
			label: `${FIELD_FOR_RULE[contribution.field].toLowerCase()} rule`,
			value: `${contribution.required ? 'required, ' : ''}needs ${needs(contribution)}; ${contribution.outcome}, ${contribution.earned} of ${contribution.points} points`,
			source: `ICP version ${icp.id}`,
			date: null,
		})
	return items.map((item, index) => ({ id: `e${index + 1}`, ...item }))
}

const hashEvidence = (evidence: EvidenceItem[]) => createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
const rationaleKey = (companyId: number, icpVersionId: number, evidenceHash: string) =>
	and(
		eq(scoreRationales.companyId, companyId),
		eq(scoreRationales.icpVersionId, icpVersionId),
		eq(scoreRationales.evidenceHash, evidenceHash),
	)

// Read-only: the cached rationale for exactly these facts, or null. Never calls the model.
export async function findRationale(
	executor: Executor,
	companyId: number,
	icpVersionId: number,
	evidence: EvidenceItem[],
) {
	const [row] = await executor
		.select()
		.from(scoreRationales)
		.where(rationaleKey(companyId, icpVersionId, hashEvidence(evidence)))
	return row ?? null
}

export interface RationaleDeps extends LlmDeps {
	db: Db
	clock: Clock
}

// The LLM explains the score; it never changes it. A rejected answer falls back to a template built from the same facts.
export async function getRationale(deps: RationaleDeps, companyId: number, icpVersionId: number) {
	const now = deps.clock()
	const icp = await icpVersion(deps.db, icpVersionId)
	const [company] = await deps.db
		.select({ fields: companyProfiles.fields })
		.from(companyProfiles)
		.where(eq(companyProfiles.companyId, companyId))
	if (!company) throw new DomainError('Company not found.', 404)
	const scored = scoreCompany(icp.rules, factsOf(company))
	const evidence = rationaleEvidence(company, scored, icp)
	const evidenceHash = hashEvidence(evidence)
	const key = rationaleKey(companyId, icp.id, evidenceHash)
	const [cached] = await deps.db.select().from(scoreRationales).where(key)
	if (cached) return cached

	const passed = scored.contributions
		.filter((c) => c.outcome === 'pass')
		.map((c) => FIELD_FOR_RULE[c.field].toLowerCase())
	const missed = scored.contributions
		.filter((c) => c.outcome !== 'pass')
		.map((c) => `${FIELD_FOR_RULE[c.field].toLowerCase()} (${c.outcome})`)
	const fallback = {
		text: `${company.fields.name.value ?? 'This company'} scores ${scored.display} out of 100: it meets ${passed.join(', ') || 'no rules'}${missed.length ? ` and misses ${missed.join(', ')}` : ''}.`,
		cites: [
			'e1',
			evidence.find((item) => item.label === 'score')!.id,
			evidence.find((item) => item.label === 'rules missed')!.id,
		],
	}
	const line = await generateGrounded(
		deps,
		{
			task: 'score_rationale',
			purpose: `Explain why ${company.fields.name.value ?? 'this company'} gets this ICP score.`,
			evidence,
			maxChars: 320,
		},
		fallback,
	)

	return deps.db.transaction(async (tx) => {
		const [row] = await tx
			.insert(scoreRationales)
			.values({ companyId, icpVersionId: icp.id, evidenceHash, evidence, ...line, createdAt: now })
			.onConflictDoNothing()
			.returning()
		if (row && line.status === 'rejected') {
			await audit(tx, {
				actor: systemActor('llm'),
				action: 'llm.output_rejected',
				entityType: 'company',
				entityId: companyId,
				reason: line.rejections.map((rejection) => rejection.code).join(','),
				result: { task: 'score_rationale', icpVersionId: icp.id, rejections: line.rejections, model: line.model },
			})
		}
		return row ?? (await tx.select().from(scoreRationales).where(key))[0]!
	})
}
