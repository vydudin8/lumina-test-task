// Domain settings shared by the server and the screens, so the UI shows the same thresholds the code applies.

export const PROVIDERS = ['apollo', 'factset', 'clay'] as const
export type ProviderName = (typeof PROVIDERS)[number]

export const PROVIDER_LABELS: Record<ProviderName, string> = { apollo: 'Apollo', factset: 'FactSet', clay: 'Clay' }

// Simulated prices: credits per record the provider returns, including records we reject.
export const CREDIT_COSTS: Record<ProviderName, { company: string; contact: string }> = {
	apollo: { company: '1', contact: '1' },
	factset: { company: '0.25', contact: '0.1' },
	clay: { company: '0.5', contact: '0.75' },
}

export const FIELDS = ['name', 'domain', 'country', 'industry', 'headcount', 'revenue', 'address', 'signals'] as const
export type FieldName = (typeof FIELDS)[number]

export const FIELD_LABELS: Record<FieldName, string> = {
	name: 'Name',
	domain: 'Domain',
	country: 'Country',
	industry: 'Industry',
	headcount: 'Headcount',
	revenue: 'Revenue',
	address: 'Office address',
	signals: 'Signals',
}

// Which provider wins when several have a value. Signals are not ranked: every reported signal counts.
export const FIELD_PRECEDENCE: Record<Exclude<FieldName, 'signals'>, ProviderName[]> = {
	// FactSet and Clay often send names in capitals; Apollo's are the most readable.
	name: ['apollo', 'factset', 'clay'],
	domain: ['apollo', 'clay', 'factset'],
	country: ['factset', 'apollo', 'clay'],
	industry: ['apollo', 'clay', 'factset'],
	headcount: ['factset', 'apollo', 'clay'],
	revenue: ['factset', 'apollo', 'clay'],
	address: ['factset', 'apollo', 'clay'],
}

// Headcount and revenue conflict when (max - min) / max is above this; other fields when normalised values differ.
export const CONFLICT_RELATIVE_DIFFERENCE = '0.1'
export const STALE_AFTER_MONTHS = 18

// Provider industry labels (lower case) mapped to our list. Anything else stays visible but counts as unknown.
export const INDUSTRY_MAP: Record<string, string> = {
	'equipment rental services': 'Plant hire',
	construction: 'Construction',
	'civil engineering': 'Civil engineering',
	'mining & metals': 'Quarrying',
	mining: 'Quarrying',
	'architecture & planning': 'Architecture',
	'architecture and planning': 'Architecture',
	'real estate': 'Real estate',
	'logistics & supply chain': 'Logistics',
	'transportation, logistics, supply chain and storage': 'Logistics',
	'computer software': 'Software',
	'software development': 'Software',
}

export const SIGNAL_LABELS: Record<string, string> = {
	fleet_telematics: 'Uses fleet telematics',
	funded: 'Has raised funding',
	net_zero_target: 'Has a net-zero target',
}

// Countries our print partner delivers to, with the postcode format each one uses.
export const MAILING_COUNTRIES = ['GB', 'IE', 'FR', 'DE', 'NL'] as const
export const MAILED_WINDOW_DAYS = 90
export const ATTRIBUTION_WINDOW_DAYS = 30

export const BLOCK_REASON_LABELS: Record<string, string> = {
	'suppressed:opt_out': 'Opted out',
	'suppressed:mailed_90d': 'Mailed in the last 90 days',
	'invalid_address:missing_address': 'No office address',
	'invalid_address:missing_line1': 'Address has no street line',
	'invalid_address:missing_city': 'Address has no town or city',
	'invalid_address:missing_postcode': 'Address has no postcode',
	'invalid_address:invalid_postcode': 'Postcode is not valid',
	'invalid_address:unsupported_country': 'We cannot post to this country',
	no_contact: 'No contact on file',
}

export const CARD_STATUS_LABELS: Record<string, string> = {
	draft: 'Draft',
	approved: 'Approved',
	rejected: 'Rejected',
	blocked: 'Blocked',
	queued: 'Queued to send',
	submitted: 'Submitted to printer',
	printed: 'Printed',
	mailed: 'Mailed',
	delivered: 'Delivered',
	returned: 'Returned',
	blocked_at_send: 'Blocked at send',
	failed: 'Failed to send',
	unconfirmed: 'Sent? Not confirmed',
}
