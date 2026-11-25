import Decimal from 'decimal.js'
import { z } from 'zod'

const base = {
	id: z.string().trim().min(1).max(40),
	points: z.number().int().min(0).max(100),
	required: z.boolean(),
}
const decimalString = z.string().regex(/^\d+(\.\d+)?$/, 'Use a plain number, e.g. 10000000')

const list = (item: z.ZodString, noun: string) => z.array(item).min(1, `Pick at least one ${noun}`)

// Either end may be open: [min, null] means "at least min", [null, max] means "at most max".
const range = <T extends z.ZodType<number | string>>(bound: T) =>
	z
		.tuple([bound.nullable(), bound.nullable()])
		.refine(([min, max]) => min !== null || max !== null, 'Set a minimum, a maximum or both')
		.refine(([min, max]) => min === null || max === null || new Decimal(String(min)).lte(String(max)), {
			message: 'The minimum is above the maximum',
			// Compare only bounds that parsed; a malformed one already has its own message.
			when: (payload) => payload.issues.length === 0,
		})

export const icpRuleSchema = z.discriminatedUnion('field', [
	z.object({ ...base, field: z.literal('industry'), op: z.literal('in'), value: list(z.string().min(1), 'industry') }),
	z.object({ ...base, field: z.literal('country'), op: z.literal('in'), value: list(z.string().length(2), 'country') }),
	z.object({ ...base, field: z.literal('headcount'), op: z.literal('between'), value: range(z.number().int().min(0)) }),
	z.object({ ...base, field: z.literal('revenueGbp'), op: z.literal('between'), value: range(decimalString) }),
	z.object({ ...base, field: z.literal('signals'), op: z.literal('any'), value: list(z.string().min(1), 'signal') }),
])

// Versions saved before ranges had open ends stored revenue as gte/lte; read them as a range, since versions never change.
const upgrade = (rule: unknown) => {
	const { op, value } = (rule ?? {}) as { op?: unknown; value?: unknown }
	if (op !== 'gte' && op !== 'lte') return rule
	return { ...(rule as object), op: 'between', value: op === 'gte' ? [value, null] : [null, value] }
}

export const icpRulesSchema = z.preprocess(
	(rules) => (Array.isArray(rules) ? rules.map(upgrade) : rules),
	z
		.array(icpRuleSchema)
		// abort: with no rules the other checks only repeat the same problem in worse words.
		.min(1, { message: 'You need to have at least 1 rule', abort: true })
		.max(20)
		.refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, 'Rule ids must be unique')
		.refine((rules) => rules.some((rule) => rule.points > 0), 'At least one rule must be worth points'),
)

export type IcpRule = z.infer<typeof icpRuleSchema>

export function describeRange<T>([min, max]: readonly [T | null, T | null], format: (value: T) => string) {
	if (min !== null && max !== null) return `between ${format(min)} and ${format(max)}`
	return min !== null ? `at least ${format(min)}` : `at most ${format(max as T)}`
}

export const ICP_FIELD_LABELS: Record<IcpRule['field'], string> = {
	industry: 'Industry',
	country: 'Country',
	headcount: 'Headcount',
	revenueGbp: 'Revenue (GBP)',
	signals: 'Signals',
}
