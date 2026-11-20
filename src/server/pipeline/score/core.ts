import { ICP_FIELD_LABELS, type IcpRule } from '#common/icp.ts'
import Decimal from 'decimal.js'

export interface CompanyFacts {
	industry: string | null
	country: string | null
	headcount: number | null
	revenueGbp: string | null
	signals: string[]
}

export interface Contribution {
	ruleId: string
	field: IcpRule['field']
	op: IcpRule['op']
	value: IcpRule['value']
	required: boolean
	points: number
	earned: number
	outcome: 'pass' | 'fail' | 'unknown'
	actual: string | number | string[] | null
}

export interface Score {
	inProfile: boolean
	outReasons: string[]
	// Exact decimal (as a string) used for ordering; display is rounded half up for people.
	score: string
	display: number
	contributions: Contribution[]
}

function evaluate(rule: IcpRule, facts: CompanyFacts): Pick<Contribution, 'outcome' | 'actual'> {
	switch (rule.field) {
		case 'industry':
		case 'country': {
			const actual = facts[rule.field]
			return { actual, outcome: actual === null ? 'unknown' : rule.value.includes(actual) ? 'pass' : 'fail' }
		}
		case 'headcount': {
			const actual = facts.headcount
			const [min, max] = rule.value
			return { actual, outcome: actual === null ? 'unknown' : actual >= min && actual <= max ? 'pass' : 'fail' }
		}
		case 'revenueGbp': {
			const actual = facts.revenueGbp
			if (actual === null) return { actual, outcome: 'unknown' }
			const passes = rule.op === 'gte' ? new Decimal(actual).gte(rule.value) : new Decimal(actual).lte(rule.value)
			return { actual, outcome: passes ? 'pass' : 'fail' }
		}
		case 'signals':
			// Signals are reported when present; no signal means the company has none we know of, which is a miss.
			return {
				actual: facts.signals,
				outcome: facts.signals.some((signal) => rule.value.includes(signal)) ? 'pass' : 'fail',
			}
	}
}

function outReason(rule: IcpRule, contribution: Contribution) {
	const label = ICP_FIELD_LABELS[rule.field]
	if (contribution.outcome === 'unknown') return `${label} is unknown`
	const expected =
		rule.op === 'in' || rule.op === 'any'
			? `one of ${rule.value.join(', ')}`
			: rule.op === 'between'
				? `between ${rule.value[0]} and ${rule.value[1]}`
				: `${rule.op === 'gte' ? 'at least' : 'at most'} ${rule.value}`
	return `${label} is ${Array.isArray(contribution.actual) ? contribution.actual.join(', ') || 'none' : String(contribution.actual)}, not ${expected}`
}

// Score = points earned / points available x 100. Unknown values earn 0; a failed or unknown required rule puts the company out.
export function scoreCompany(rules: IcpRule[], facts: CompanyFacts): Score {
	const contributions = rules.map((rule): Contribution => {
		const { outcome, actual } = evaluate(rule, facts)
		return {
			ruleId: rule.id,
			field: rule.field,
			op: rule.op,
			value: rule.value,
			required: rule.required,
			points: rule.points,
			earned: outcome === 'pass' ? rule.points : 0,
			outcome,
			actual,
		}
	})
	const outReasons = rules.flatMap((rule, index) =>
		rule.required && contributions[index]!.outcome !== 'pass' ? [outReason(rule, contributions[index]!)] : [],
	)
	const available = rules.reduce((sum, rule) => sum + rule.points, 0)
	const earned = contributions.reduce((sum, contribution) => sum + contribution.earned, 0)
	const score = new Decimal(earned).div(available).times(100)
	return {
		inProfile: outReasons.length === 0,
		outReasons,
		score: score.toString(),
		display: score.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber(),
		contributions,
	}
}

export interface Ranked {
	companyId: number
	score: Score
}

// Highest exact score first; ties broken by company id so the order never depends on the database.
export function rankCompanies(rules: IcpRule[], companies: { companyId: number; facts: CompanyFacts }[]) {
	const scored = companies.map(({ companyId, facts }) => ({ companyId, score: scoreCompany(rules, facts) }))
	return {
		inProfile: scored
			.filter((row) => row.score.inProfile)
			.sort((a, b) => new Decimal(b.score.score).comparedTo(a.score.score) || a.companyId - b.companyId),
		outOfProfile: scored.filter((row) => !row.score.inProfile).sort((a, b) => a.companyId - b.companyId),
	}
}
