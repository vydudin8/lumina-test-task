import { icpRulesSchema, type IcpRule } from '#common/icp.ts'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ICP_RULES } from '../../seed/defaults.ts'
import { rankCompanies, scoreCompany, type CompanyFacts } from './core.ts'

const rules = icpRulesSchema.parse(DEFAULT_ICP_RULES)
const fits: CompanyFacts = {
	industry: 'Quarrying',
	country: 'GB',
	headcount: 240,
	revenueGbp: '15800000',
	signals: ['funded'],
}

describe('icpRulesSchema', () => {
	it('accepts the default ICP', () => {
		expect(rules).toHaveLength(5)
	})

	it('rejects duplicate rule ids, an empty list and a headcount range upside down', () => {
		expect(icpRulesSchema.safeParse([...rules, rules[0]]).success).toBe(false)
		expect(icpRulesSchema.safeParse([]).success).toBe(false)
		expect(
			icpRulesSchema.safeParse([
				{ id: 'h', field: 'headcount', op: 'between', value: [500, 50], points: 10, required: false },
			]).success,
		).toBe(false)
	})
})

describe('scoreCompany', () => {
	it('scores 100 when every rule passes', () => {
		const score = scoreCompany(rules, fits)
		expect(score).toMatchObject({ inProfile: true, score: '100', display: 100, outReasons: [] })
		expect(score.contributions.map((c) => [c.ruleId, c.outcome, c.earned])).toEqual([
			['industry', 'pass', 30],
			['country', 'pass', 20],
			['headcount', 'pass', 20],
			['revenue', 'pass', 20],
			['signals', 'pass', 10],
		])
	})

	it('gives 0 points for an unknown value and says so instead of calling it a failure', () => {
		const score = scoreCompany(rules, { ...fits, revenueGbp: null })
		expect(score).toMatchObject({ inProfile: true, score: '80' })
		expect(score.contributions.find((c) => c.ruleId === 'revenue')).toMatchObject({ outcome: 'unknown', earned: 0 })
	})

	it('puts a company out when a required rule fails or is unknown, with the reason', () => {
		expect(scoreCompany(rules, { ...fits, country: 'FR' })).toMatchObject({
			inProfile: false,
			outReasons: ['Country is FR, not one of GB, IE'],
		})
		expect(scoreCompany(rules, { ...fits, industry: null })).toMatchObject({
			inProfile: false,
			outReasons: ['Industry is unknown'],
		})
	})

	it('treats no reported signal as a miss, not as unknown', () => {
		expect(
			scoreCompany(rules, { ...fits, signals: [] }).contributions.find((c) => c.ruleId === 'signals'),
		).toMatchObject({ outcome: 'fail' })
	})

	it('keeps the exact decimal and rounds half up only for display', () => {
		const thirds: IcpRule[] = [
			{ id: 'a', field: 'country', op: 'in', value: ['GB'], points: 2, required: false },
			{ id: 'b', field: 'headcount', op: 'between', value: [1, 10], points: 1, required: false },
		]
		const score = scoreCompany(thirds, fits)
		expect(score.score).toBe('66.666666666666666667')
		expect(score.display).toBe(67)
		const eighth: IcpRule[] = [
			{ id: 'a', field: 'country', op: 'in', value: ['GB'], points: 1, required: false },
			{ id: 'b', field: 'headcount', op: 'between', value: [1, 10], points: 7, required: false },
		]
		expect(scoreCompany(eighth, fits)).toMatchObject({ score: '12.5', display: 13 })
	})

	it('compares revenue in exact decimals', () => {
		const edge: IcpRule[] = [{ id: 'r', field: 'revenueGbp', op: 'gte', value: '10000000', points: 1, required: false }]
		expect(scoreCompany(edge, { ...fits, revenueGbp: '9999999.99' }).contributions[0]?.outcome).toBe('fail')
		expect(scoreCompany(edge, { ...fits, revenueGbp: '10000000.00' }).contributions[0]?.outcome).toBe('pass')
	})
})

describe('rankCompanies', () => {
	it('orders by exact score, then company id, and leaves out-of-profile companies out', () => {
		const ranked = rankCompanies(rules, [
			{ companyId: 9, facts: { ...fits, signals: [] } },
			{ companyId: 3, facts: fits },
			{ companyId: 1, facts: { ...fits, signals: [] } },
			{ companyId: 2, facts: { ...fits, country: 'DE' } },
		])
		expect(ranked.inProfile.map((row) => [row.companyId, row.score.display])).toEqual([
			[3, 100],
			[1, 90],
			[9, 90],
		])
		expect(ranked.outOfProfile.map((row) => row.companyId)).toEqual([2])
	})
})
