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
	{ id: 'revenue', field: 'revenueGbp', op: 'between', value: ['10000000', null], points: 20, required: false },
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
		name: 'Site demo day',
		body: 'Hi {{first_name}},\n\n{{personal_line}}\n\nLumina builds battery-electric excavators and dumpers for sites that want less noise and no diesel deliveries. Book a demo day at your next site: lumina.example/demo',
	},
	{
		name: 'Running costs',
		body: 'Dear {{first_name}},\n\n{{personal_line}}\n\nElectric plant from Lumina charges overnight on site and needs far less servicing than diesel. See what that means for {{company}}: lumina.example/costs',
	},
	{
		name: 'Zero-emission tenders',
		body: "Hello {{first_name}},\n\n{{personal_line}}\n\nMore tenders and city sites now ask for zero-emission plant. Lumina's battery-electric excavators and dumpers qualify as they are, with no retrofit. See which of your bids they open up: lumina.example/zero-emission",
	},
]
