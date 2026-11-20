export const DEFAULT_ICP_RULES = [
	{
		id: 'industry',
		field: 'industry',
		op: 'in',
		value: ['Plant hire', 'Construction', 'Civil engineering', 'Quarrying'],
		points: 30,
		required: true,
	},
	{ id: 'country', field: 'country', op: 'in', value: ['GB', 'IE'], points: 20, required: true },
	{ id: 'headcount', field: 'headcount', op: 'between', value: [50, 5000], points: 20, required: false },
	{ id: 'revenue', field: 'revenueGbp', op: 'gte', value: '10000000', points: 20, required: false },
	{
		id: 'signals',
		field: 'signals',
		op: 'any',
		value: ['fleet_telematics', 'funded', 'net_zero_target'],
		points: 10,
		required: false,
	},
]

export const DEFAULT_TEMPLATES = [
	{
		name: 'A: site demo',
		variant: 'A',
		body: 'Hi {{first_name}}, {{personal_line}} Lumina builds battery-electric excavators and dumpers for sites that want less noise and no diesel deliveries. Book a demo day at your next site: lumina.example/demo',
	},
	{
		name: 'B: running costs',
		variant: 'B',
		body: 'Dear {{first_name}}, {{personal_line}} Electric plant from Lumina charges overnight on site and needs far less servicing than diesel. See what that means for {{company}}: lumina.example/costs',
	},
]
