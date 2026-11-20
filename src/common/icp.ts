import { z } from 'zod'

const base = {
	id: z.string().trim().min(1).max(40),
	points: z.number().int().min(0).max(100),
	required: z.boolean(),
}
const decimalString = z.string().regex(/^\d+(\.\d+)?$/, 'Use a plain number, e.g. 10000000')

export const icpRuleSchema = z.discriminatedUnion('field', [
	z.object({ ...base, field: z.literal('industry'), op: z.literal('in'), value: z.array(z.string().min(1)).min(1) }),
	z.object({ ...base, field: z.literal('country'), op: z.literal('in'), value: z.array(z.string().length(2)).min(1) }),
	z.object({
		...base,
		field: z.literal('headcount'),
		op: z.literal('between'),
		value: z
			.tuple([z.number().int().min(0), z.number().int().min(0)])
			.refine(([min, max]) => min <= max, 'The minimum is above the maximum'),
	}),
	z.object({ ...base, field: z.literal('revenueGbp'), op: z.enum(['gte', 'lte']), value: decimalString }),
	z.object({ ...base, field: z.literal('signals'), op: z.literal('any'), value: z.array(z.string().min(1)).min(1) }),
])

export const icpRulesSchema = z
	.array(icpRuleSchema)
	.min(1)
	.max(20)
	.refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, 'Rule ids must be unique')
	.refine((rules) => rules.some((rule) => rule.points > 0), 'At least one rule must be worth points')

export type IcpRule = z.infer<typeof icpRuleSchema>

export const ICP_FIELD_LABELS: Record<IcpRule['field'], string> = {
	industry: 'Industry',
	country: 'Country',
	headcount: 'Headcount',
	revenueGbp: 'Revenue (GBP)',
	signals: 'Signals',
}
