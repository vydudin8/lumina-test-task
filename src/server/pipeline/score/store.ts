import { icpRulesSchema, type IcpRule } from '#common/icp.ts'
import { FIELD_LABELS, PROVIDER_LABELS, SIGNAL_LABELS } from '#common/settings.ts'
import { and, desc, eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { audit, systemActor } from '../../audit.ts'
import type { Db, Executor } from '../../db/client.ts'
import { icpVersions, scoreRationales } from '../../db/schema.ts'
import type { Clock } from '../../lib/clock.ts'
import { DomainError } from '../../lib/errors.ts'
import { generateGrounded, type LlmDeps } from '../../llm/generate.ts'
import type { EvidenceItem } from '../../llm/types.ts'
import { loadMaster, type MasterCompany } from '../resolve/store.ts'
import { rankCompanies, type CompanyFacts, type Score } from './core.ts'

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
		const previous = await currentIcp(tx)
		const [row] = await tx
			.insert(icpVersions)
			.values({ rules, createdBy: input.actor.id, createdAt: input.now })
			.returning()
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

export const factsOf = (company: MasterCompany): CompanyFacts => ({
	industry: company.fields.industry.value,
	country: company.fields.country.value,
	headcount: company.fields.headcount.value,
	revenueGbp: company.fields.revenue.value?.gbp ?? null,
	signals: company.fields.signals.value ?? [],
})

export interface RankedCompany {
	rank: number
	company: MasterCompany
	score: Score
}

export function scoreCompanies(companies: MasterCompany[], icp: IcpVersion) {
	const byId = new Map(companies.map((company) => [company.id, company]))
	const { inProfile, outOfProfile } = rankCompanies(
		icp.rules,
		companies.map((company) => ({ companyId: company.id, facts: factsOf(company) })),
	)
	return {
		ranked: inProfile.map((row, index): RankedCompany => ({
			rank: index + 1,
			company: byId.get(row.companyId)!,
			score: row.score,
		})),
		outOfProfile: outOfProfile.map((row) => ({ company: byId.get(row.companyId)!, score: row.score })),
	}
}

export async function scoreMaster(executor: Executor, icp: IcpVersion, now: Date) {
	return scoreCompanies((await loadMaster(executor, now)).companies, icp)
}

const integer = new Intl.NumberFormat('en-GB')
const pounds = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 })
const day = (value: string | null) => value?.slice(0, 10) ?? null

// Numbered facts the model may use. Values are formatted exactly as people see them, so the guard can match numbers.
export function rationaleEvidence(company: MasterCompany, score: Score, icp: IcpVersion): EvidenceItem[] {
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
		field: { provider: string | null; asOf: string | null; fetchedAt: string | null },
	) =>
		items.push({
			label,
			value: value ?? 'unknown',
			source: field.provider ?? 'no provider',
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

const FIELD_FOR_RULE: Record<IcpRule['field'], string> = {
	industry: FIELD_LABELS.industry,
	country: FIELD_LABELS.country,
	headcount: FIELD_LABELS.headcount,
	revenueGbp: FIELD_LABELS.revenue,
	signals: FIELD_LABELS.signals,
}

// The LLM explains the score; it never changes it. A rejected answer falls back to a template built from the same facts.
export async function getRationale(deps: RationaleDeps, companyId: number, icpVersionId: number) {
	const now = deps.clock()
	const icp = await icpVersion(deps.db, icpVersionId)
	const companies = (await loadMaster(deps.db, now)).companies
	const company = companies.find((candidate) => candidate.id === companyId)
	if (!company) throw new DomainError('Company not found.', 404)
	const score = scoreCompanies([company], icp)
	const scored = score.ranked[0]?.score ?? score.outOfProfile[0]!.score
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
