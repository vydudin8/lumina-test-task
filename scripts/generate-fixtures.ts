// Generates provider-shaped fixtures plus manifest.json, the ground truth the tests check the pipeline against.
// Deterministic: a seeded PRNG and no clock, so a re-run produces the same bytes. Run: pnpm fixtures
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const FIXTURES_DIR = `${import.meta.dirname}/../fixtures`
// Provider "as of" dates are fixed relative to this day. Seed-owned dates (history.json) are relative to the seed run.
export const FIXTURE_ANCHOR = '2026-11-20'
const SEED = 20261120

export const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

type Provider = 'apollo' | 'factset' | 'clay'
type Country = 'GB' | 'IE' | 'FR' | 'DE' | 'NL' | 'CH'
type Tier = 'top100' | 'top90' | 'rest' | 'nontarget' | 'foreign' | 'unknown'
type Func = 'operations' | 'fleet' | 'procurement' | 'sustainability' | 'other'
type Seniority = 'c_suite' | 'vp' | 'director' | 'head' | 'manager' | 'other'
type Signal = 'fleet_telematics' | 'funded' | 'net_zero_target'
type InvalidReason = 'missing_line1' | 'missing_city' | 'missing_postcode' | 'invalid_postcode' | 'unsupported_country'
type ProviderRecord = { provider: Provider; externalId: string }

interface Address {
	line1: string | null
	city: string | null
	region: string | null
	postcode: string | null
	country: Country
}

interface Person {
	first: string
	last: string
	title: string
	func: Func
	seniority: Seniority
	email: string
	providers: Provider[]
	// Provider-specific spelling of the same email (case only), to prove normalisation.
	emailVariant?: { provider: Provider; email: string }
	intended: boolean
}

interface Company {
	key: string
	providers: Provider[]
	tier: Tier
	country: Country
	industry: string
	base: string
	legal: string
	domain: string
	headcount: number | null
	revenueGbp: number | null
	signals: Signal[]
	address: Address
	invalid?: InvalidReason
	headcountConflict?: { loserFactor: number }
	// One provider still lists an old office: the street differs, so the address shows as a conflict.
	addressConflict?: { provider: Provider; line1: string }
	missingDomainOn?: Provider
	staleFactset?: boolean
	persons: Person[]
	ids: Partial<Record<Provider, string>>
	tricks: string[]
}

export interface Manifest {
	version: number
	anchor: string
	counts: {
		companyRecords: number
		contactRecords: number
		uniqueCompanies: number
		duplicateCompanies: number
		duplicateContacts: number
		headcountConflicts: number
		addressConflicts: number
		suppressed: number
		optOuts: number
		pilotMailed: number
		invalidAddresses: number
		byProvider: Record<Provider, { companies: number; contacts: number }>
	}
	duplicates: { companyKey: string; name: string; domain: string; records: ProviderRecord[]; tricks: string[] }[]
	nearDuplicates: {
		companies: { companyKey: string; name: string; country: Country; domain: string; records: ProviderRecord[] }[]
	}[]
	headcountConflicts: { companyKey: string; values: { provider: Provider; headcount: number }[] }[]
	addressConflicts: { companyKey: string; inTop50: boolean; values: { provider: Provider; line1: string | null }[] }[]
	suppressed: {
		personKey: string
		reason: 'opt_out' | 'mailed_90d'
		companyKey: string
		inTop50: boolean
		viaDuplicateContact: boolean
	}[]
	invalidAddresses: { companyKey: string; reason: InvalidReason; inTop50: boolean; records: ProviderRecord[] }[]
	top50: {
		expectedEligible: number
		nextBestScore: number
		companies: {
			companyKey: string
			name: string
			domain: string
			records: ProviderRecord[]
			expectedScore: number
			recipient: string
			expected: string
		}[]
	}
	recipientTieBreaks: { companyKey: string; rule: string; winner: string; loser: string }[]
	staleFactset: { companyKey: string; fsymId: string; fiscalEndDate: string }[]
	malformed: { provider: Provider; kind: 'company' | 'contact' | 'fundamental'; problem: string }[]
	historical: {
		cards: number
		byVariant: Record<'A' | 'B', Record<'sent' | 'delivered' | 'returned' | 'replies' | 'visits' | 'meetings', number>>
		outsideWindow: number
	}
}

// Reference data shared with the seed: GBP per unit of currency.
export const FX_RATES = [
	{ currency: 'GBP', rate: '1', as_of: '2026-10-30' },
	{ currency: 'USD', rate: '0.79', as_of: '2026-10-30' },
	{ currency: 'EUR', rate: '0.85', as_of: '2026-10-30' },
	{ currency: 'CHF', rate: '0.89', as_of: '2026-10-30' },
]
const FX: Record<string, number> = { GBP: 1, USD: 0.79, EUR: 0.85, CHF: 0.89 }

function mulberry32(seed: number) {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function at<T>(items: readonly T[], index: number): T {
	const item = items[index]
	if (item === undefined) throw new Error(`index ${index} out of range (${items.length})`)
	return item
}

const TARGET_INDUSTRIES = ['Plant hire', 'Construction', 'Civil engineering', 'Quarrying']
const OTHER_INDUSTRIES = ['Architecture', 'Real estate', 'Logistics', 'Software']
// How each provider labels our canonical industries (LinkedIn-style labels).
const INDUSTRY_LABELS: Record<string, { apollo: string; clay: string }> = {
	'Plant hire': { apollo: 'equipment rental services', clay: 'Equipment Rental Services' },
	Construction: { apollo: 'construction', clay: 'Construction' },
	'Civil engineering': { apollo: 'civil engineering', clay: 'Civil Engineering' },
	Quarrying: { apollo: 'mining & metals', clay: 'Mining' },
	Architecture: { apollo: 'architecture & planning', clay: 'Architecture and Planning' },
	'Real estate': { apollo: 'real estate', clay: 'Real Estate' },
	Logistics: { apollo: 'logistics & supply chain', clay: 'Transportation, Logistics, Supply Chain and Storage' },
	Software: { apollo: 'computer software', clay: 'Software Development' },
}
const NAME_SUFFIXES: Record<string, string[]> = {
	'Plant hire': ['Plant Hire', 'Plant', 'Equipment Hire', 'Tool & Plant Hire'],
	Construction: ['Construction', 'Contractors', 'Builders', 'Building'],
	'Civil engineering': ['Civil Engineering', 'Civils', 'Groundworks', 'Infrastructure'],
	Quarrying: ['Aggregates', 'Quarries', 'Stone', 'Minerals'],
	Architecture: ['Architects', 'Design Studio'],
	'Real estate': ['Property', 'Estates'],
	Logistics: ['Logistics', 'Haulage', 'Freight'],
	Software: ['Software', 'Digital', 'Systems'],
}
const DESCRIPTIONS: Record<string, string> = {
	'Plant hire': 'hires out excavators, dumpers and other construction plant',
	Construction: 'is a building contractor for commercial and public sector projects',
	'Civil engineering': 'delivers civil engineering and infrastructure works',
	Quarrying: 'operates quarries and supplies aggregates',
	Architecture: 'is an architecture and planning practice',
	'Real estate': 'develops and manages commercial property',
	Logistics: 'provides haulage and warehousing services',
	Software: 'builds software for the built environment',
}
const PREFIXES =
	'Hartley Brennan Calder Ashworth Pennine Mercia Thames Severn Wessex Northgate Kestrel Granite Ridgeway Fenwick Holloway Ormond Tyne Dunmore Langley Whitcombe Ashdown Barlow Carrick Denholm Elmhurst Farley Garside Halden Ingram Jarrow Kirkby Lomax Marston Netherby Oakridge Pemberton Quarrington Redmire Stanton Thornbury Upton Vale Wardle Yardley Alder Birchwood Coldstream Dovecote Eskdale Foxley Glenmore Hawkridge Ironbridge Kingsmead Lytham Moorcroft Norwood Ottery Penrose Rowntree Saltash Trent Ullswater Wyvern Blackrock Shannon Liffey Boyne Slaney Mourne'.split(
		' ',
	)
const FIRST_NAMES =
	'Sarah Liam Aisha Tom Priya James Olivia Mohammed Emma Daniel Chloe Ryan Fatima Owen Grace Ciaran Niamh Rhys Megan Arjun Hannah Kwame Sophie Lewis Zara Patrick Aoife Marcus Imogen Callum Leah Tariq Freya Connor Ellie Joseph Amara Harry Isla Declan Ruth Samuel Mei Gareth Bethan Rohan Lucy Adam Sinead Oliver Nadia Ben Erin Femi Katie Euan Holly Ibrahim Laura Matthew Siobhan Noah Anya Jack Rachel Kieran Yusuf Charlotte Alex Martha Dev Jade'.split(
		' ',
	)
const LAST_NAMES =
	"Doyle Okafor Shah Murphy Patel Walsh Kowalski Hughes Byrne Evans Khan Thompson O'Brien Campbell Ahmed Roberts Kelly Singh Davies Novak Clarke Mensah Taylor Fitzgerald Lewis Hussain Morgan Reid Chen Wright Edwards Iqbal Fraser Nolan Jenkins Asante Gallagher Price Bennett Rahman Moore Quinn Baker Owusu Sutherland Ryan Mitchell Ali Cooper Dunne Harris Begum Stewart McCarthy Turner Malik Phillips Duffy Hall Kaur Ross Lynch Ward Nowak Grant Kennedy Watson Osei Bell Daly Wood Chowdhury Scott Healy Green Adeyemi Murray Burke Hill Rossi".split(
		' ',
	)
const TITLES: Record<Func, Partial<Record<Seniority, string[]>>> = {
	operations: {
		c_suite: ['Chief Operating Officer'],
		director: ['Operations Director'],
		head: ['Head of Operations'],
		manager: ['Operations Manager'],
	},
	fleet: {
		director: ['Plant Director'],
		head: ['Head of Plant', 'Head of Fleet'],
		manager: ['Plant Manager', 'Fleet Manager'],
	},
	procurement: {
		director: ['Procurement Director'],
		head: ['Head of Procurement'],
		manager: ['Procurement Manager', 'Purchasing Manager'],
	},
	sustainability: {
		director: ['Sustainability Director'],
		head: ['Head of Sustainability'],
		manager: ['Sustainability Manager', 'ESG Manager'],
	},
	other: {
		c_suite: ['Chief Executive Officer', 'Chief Financial Officer'],
		director: ['Managing Director', 'Finance Director', 'Commercial Director', 'Sales Director'],
		head: ['Head of Finance', 'Head of HR'],
		manager: ['HR Manager', 'Marketing Manager', 'Site Manager', 'Contracts Manager'],
		other: ['Estimator', 'Quantity Surveyor', 'Office Administrator'],
	},
}
const FUNC_RANK: Func[] = ['operations', 'fleet', 'procurement', 'sustainability', 'other']
const APOLLO_FUNCTION: Record<Func, { functions: string[]; departments: string[] }> = {
	operations: { functions: ['operations'], departments: ['master_operations'] },
	// Apollo has no fleet/plant function; plant people show up as engineering, so only the title identifies them.
	fleet: { functions: ['engineering'], departments: ['master_engineering_technical'] },
	procurement: { functions: ['purchasing'], departments: ['master_operations'] },
	sustainability: { functions: [], departments: [] },
	other: { functions: ['finance'], departments: ['master_finance'] },
}
const FACTSET_FUNCTION: Record<Func, string> = {
	operations: 'Operations',
	fleet: 'Engineering',
	procurement: 'Purchasing',
	sustainability: 'Corporate Social Responsibility',
	other: 'Finance',
}
const CLAY_SENIORITY: Record<Seniority, string> = {
	c_suite: 'C-Suite',
	vp: 'VP',
	director: 'Director',
	head: 'Head',
	manager: 'Manager',
	other: 'Senior',
}
const CLAY_DEPARTMENT: Record<Func, string> = {
	operations: 'Operations',
	fleet: 'Engineering',
	procurement: 'Procurement',
	sustainability: 'Sustainability',
	other: 'Finance',
}
const COUNTRY_NAMES: Record<Country, { apollo: string; clay: string }> = {
	GB: { apollo: 'United Kingdom', clay: 'UK' },
	IE: { apollo: 'Ireland', clay: 'Ireland' },
	FR: { apollo: 'France', clay: 'France' },
	DE: { apollo: 'Germany', clay: 'Germany' },
	NL: { apollo: 'Netherlands', clay: 'Netherlands' },
	CH: { apollo: 'Switzerland', clay: 'Switzerland' },
}
const TLD: Record<Country, string> = { GB: 'co.uk', IE: 'ie', FR: 'fr', DE: 'de', NL: 'nl', CH: 'ch' }
const LEGAL: Record<Country, string[]> = {
	GB: ['Ltd', 'Ltd', 'Limited', 'PLC'],
	IE: ['Limited', 'Ltd', 'DAC'],
	FR: ['SAS', 'SA'],
	DE: ['GmbH', 'AG'],
	NL: ['B.V.'],
	CH: ['AG'],
}
const CURRENCY: Record<Country, string> = { GB: 'GBP', IE: 'EUR', FR: 'EUR', DE: 'EUR', NL: 'EUR', CH: 'CHF' }
const UK_CITIES = [
	['Leeds', 'West Yorkshire', 'LS'],
	['Manchester', 'Greater Manchester', 'M'],
	['Birmingham', 'West Midlands', 'B'],
	['Bristol', 'Bristol', 'BS'],
	['Sheffield', 'South Yorkshire', 'S'],
	['Newcastle upon Tyne', 'Tyne and Wear', 'NE'],
	['Glasgow', 'Glasgow City', 'G'],
	['Cardiff', 'Cardiff', 'CF'],
	['Nottingham', 'Nottinghamshire', 'NG'],
	['Leicester', 'Leicestershire', 'LE'],
	['Reading', 'Berkshire', 'RG'],
	['Peterborough', 'Cambridgeshire', 'PE'],
	['Exeter', 'Devon', 'EX'],
	['Preston', 'Lancashire', 'PR'],
	['Derby', 'Derbyshire', 'DE'],
	['York', 'North Yorkshire', 'YO'],
	['Edinburgh', 'City of Edinburgh', 'EH'],
] as const
const IE_CITIES = [
	['Dublin', 'Dublin', 'D02'],
	['Cork', 'Cork', 'T12'],
	['Galway', 'Galway', 'H91'],
	['Limerick', 'Limerick', 'V94'],
	['Waterford', 'Waterford', 'X91'],
] as const
const EU_CITIES: Record<'FR' | 'DE' | 'NL' | 'CH', readonly (readonly [string, string, string])[]> = {
	FR: [
		['Lyon', 'Auvergne-Rhône-Alpes', '69003'],
		['Lille', 'Hauts-de-France', '59000'],
		['Nantes', 'Pays de la Loire', '44000'],
	],
	DE: [
		['Hamburg', 'Hamburg', '20095'],
		['Köln', 'Nordrhein-Westfalen', '50667'],
		['Stuttgart', 'Baden-Württemberg', '70173'],
	],
	NL: [
		['Rotterdam', 'Zuid-Holland', '3011 AB'],
		['Utrecht', 'Utrecht', '3511 CE'],
		['Eindhoven', 'Noord-Brabant', '5611 AZ'],
	],
	CH: [['Zürich', 'Zürich', '8001']],
}
const UK_STREETS = [
	'Mill Lane',
	'Station Road',
	'Canal Street',
	'Quarry Road',
	'Riverside Way',
	'Wharf Street',
	'Foundry Lane',
	'Kingsway',
]
const ESTATES = ['Brunswick', 'Riverside', 'Westgate', 'Lakeside', 'Northfield', 'Meadowbank']

export function generateFixtures(): Record<string, unknown> {
	const rng = mulberry32(SEED)
	const int = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1))
	const pick = <T>(items: readonly T[]): T => at(items, Math.floor(rng() * items.length))
	const chance = (p: number) => rng() < p
	const hex = (length: number) => Array.from({ length }, () => Math.floor(rng() * 16).toString(16)).join('')
	const alnum = (length: number) =>
		Array.from({ length }, () => pick('0123456789BCDFGHJKLMNPQRSTVWXZ'.split(''))).join('')
	function shuffle<T>(items: T[]): T[] {
		const copy = [...items]
		for (let i = copy.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1))
			;[copy[i], copy[j]] = [at(copy, j), at(copy, i)]
		}
		return copy
	}

	// 1. Which provider(s) know each company, and where it should land under the default ICP.
	const AF: Provider[] = ['apollo', 'factset']
	const AC: Provider[] = ['apollo', 'clay']
	const CF: Provider[] = ['clay', 'factset']
	// prettier-ignore
	const plan: [number, Provider[], Tier | 'top'][] = [
		[5, AF, 'top'], [3, AC, 'top'], [2, CF, 'top'],
		[2, AF, 'rest'], [1, AC, 'rest'], [1, CF, 'rest'],
		[1, AF, 'nontarget'], [1, AC, 'nontarget'],
		[1, AC, 'foreign'], [1, CF, 'foreign'],
		[26, ['apollo'], 'top'], [50, ['apollo'], 'rest'], [25, ['apollo'], 'nontarget'], [15, ['apollo'], 'foreign'],
		[14, ['clay'], 'top'], [40, ['clay'], 'rest'], [20, ['clay'], 'nontarget'], [6, ['clay'], 'foreign'],
		[68, ['factset'], 'unknown'],
	]
	const companies: Company[] = []
	for (const [count, providers, tier] of plan) {
		for (let i = 0; i < count; i++) {
			companies.push({
				key: `c${String(companies.length + 1).padStart(3, '0')}`,
				providers,
				tier: tier === 'top' ? 'top90' : tier,
				country: 'GB',
				industry: '',
				base: '',
				legal: '',
				domain: '',
				headcount: null,
				revenueGbp: null,
				signals: [],
				address: { line1: null, city: null, region: null, postcode: null, country: 'GB' },
				persons: [],
				ids: {},
				tricks: [],
			})
		}
	}
	const isDuplicate = (company: Company) => company.providers.length === 2
	const top = companies.filter((company) => company.tier === 'top90')
	for (const company of shuffle(top).slice(0, 22)) company.tier = 'top100'
	const isTop = (company: Company) => company.tier === 'top100' || company.tier === 'top90'
	const byShape = (tier: (company: Company) => boolean, providers: Provider[]) =>
		companies.filter((company) => tier(company) && company.providers.join() === providers.join())
	const isRest = (company: Company) => company.tier === 'rest'

	const topAF = byShape(isTop, AF)
	const topAC = byShape(isTop, AC)
	const topCF = byShape(isTop, CF)
	const topA = byShape(isTop, ['apollo'])
	const topC = byShape(isTop, ['clay'])
	const restAF = byShape(isRest, AF)
	const restCF = byShape(isRest, CF)
	const restA = byShape(isRest, ['apollo'])
	const restC = byShape(isRest, ['clay'])
	const foreignA = byShape((company) => company.tier === 'foreign', ['apollo'])
	const nontargetAF = byShape((company) => company.tier === 'nontarget', AF)
	const nontargetAC = byShape((company) => company.tier === 'nontarget', AC)

	// 2. Countries and industries.
	for (const company of companies) {
		if (company.tier === 'foreign') company.country = pick(['FR', 'DE', 'NL'] as const)
		else if (company.tier === 'unknown') company.country = chance(0.75) ? 'GB' : pick(['IE', 'FR', 'DE', 'NL'] as const)
		else company.country = chance(0.15) ? 'IE' : 'GB'

		const targeted = company.tier !== 'nontarget' && !(company.tier === 'unknown' && chance(0.3))
		company.industry = pick(targeted ? TARGET_INDUSTRIES : OTHER_INDUSTRIES)
		company.legal = pick(LEGAL[company.country])
	}
	const unsupportedCountry = at(foreignA, 0)
	unsupportedCountry.country = 'CH'
	unsupportedCountry.legal = 'AG'
	const nearPairs: [Company, Company][] = [
		[at(restA, 3), at(restC, 2)],
		[at(restA, 4), at(foreignA, 1)],
	]
	for (const [gb, other] of nearPairs) {
		gb.country = 'GB'
		gb.legal = 'Ltd'
		other.industry = gb.industry
	}
	at(restC, 2).country = 'IE'
	at(restC, 2).legal = 'Limited'
	at(foreignA, 1).country = 'NL'
	at(foreignA, 1).legal = 'B.V.'

	// 3. Unique names and domains (near-duplicates deliberately share a name).
	const usedBases = new Set<string>()
	const usedDomains = new Set<string>()
	const pools = new Map(
		Object.entries(NAME_SUFFIXES).map(([industry, suffixes]) => [
			industry,
			shuffle(PREFIXES.flatMap((prefix) => suffixes.map((suffix) => `${prefix} ${suffix}`))),
		]),
	)
	const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')
	function assignDomain(company: Company) {
		const [prefix = '', firstWord = ''] = company.base.split(' ')
		for (const candidate of [slug(prefix + firstWord), slug(company.base)]) {
			const domain = `${candidate}.${TLD[company.country]}`
			if (!usedDomains.has(domain)) {
				usedDomains.add(domain)
				company.domain = domain
				return
			}
		}
		throw new Error(`no free domain for ${company.base}`)
	}
	const partnerOf = new Map(nearPairs.map(([gb, other]) => [other, gb]))
	for (const company of companies) {
		if (partnerOf.has(company)) continue
		const pool = pools.get(company.industry)!
		let base = pool.pop()
		while (base && usedBases.has(base)) base = pool.pop()
		if (!base) throw new Error(`name pool exhausted for ${company.industry}`)
		usedBases.add(base)
		company.base = base
		assignDomain(company)
	}
	for (const [other, gb] of partnerOf) {
		other.base = gb.base
		assignDomain(other)
	}

	// 4. Size, revenue and signals. Top tiers pass every rule; everyone else in profile fails at least one.
	const signalCarriers = (company: Company): Signal[] => [
		...(company.providers.includes('apollo') ? (['fleet_telematics', 'funded'] as const) : []),
		...(company.providers.includes('clay') ? (['net_zero_target'] as const) : []),
	]
	const roundTo = (value: number, step: number) => Math.round(value / step) * step
	for (const company of companies) {
		if (isTop(company)) {
			company.headcount = int(80, 2400)
			company.revenueGbp = roundTo(int(15_000_000, 180_000_000), 1000)
			company.signals = company.tier === 'top100' ? [pick(signalCarriers(company))] : []
		} else if (isRest(company)) {
			const variant = pick(['small', 'lowRevenue', 'unknownRevenue'] as const)
			company.headcount = variant === 'small' ? int(8, 45) : int(60, 800)
			company.revenueGbp = variant === 'unknownRevenue' ? null : roundTo(int(1_500_000, 7_500_000), 1000)
			company.signals = chance(0.4) ? [pick(signalCarriers(company))] : []
		} else {
			company.headcount = chance(0.9) ? int(5, 3000) : null
			company.revenueGbp = chance(0.8) ? roundTo(int(500_000, 150_000_000), 1000) : null
			const carriers = signalCarriers(company)
			company.signals = carriers.length && chance(0.3) ? [pick(carriers)] : []
		}
	}

	// 5. Office addresses, valid unless deliberately broken.
	for (const company of companies) {
		const { country } = company
		if (country === 'GB') {
			const [city, region, area] = pick(UK_CITIES)
			const letters = 'ABDEFGHJLNPQRSTUWXYZ'.split('')
			company.address = {
				line1: chance(0.5)
					? `${int(1, 240)} ${pick(UK_STREETS)}`
					: `Unit ${int(1, 30)}, ${pick(ESTATES)} Industrial Estate`,
				city,
				region,
				postcode: `${area}${int(1, 28)} ${int(1, 9)}${pick(letters)}${pick(letters)}`,
				country,
			}
		} else if (country === 'IE') {
			const [city, region, routing] = pick(IE_CITIES)
			const chars = '0123456789ACDEFHKNPRTVWXY'.split('')
			company.address = {
				line1: `Unit ${int(1, 30)}, ${pick(ESTATES)} Business Park`,
				city,
				region,
				postcode: `${routing} ${pick('ACDEFHKNPRTVWXY'.split(''))}${pick(chars)}${pick(chars)}${pick(chars)}`,
				country,
			}
		} else {
			const [city, region, postcode] = pick(EU_CITIES[country])
			const street = { FR: 'rue du Port', DE: 'Industriestraße', NL: 'Havenweg', CH: 'Industriestrasse' }[country]
			company.address = {
				line1: country === 'FR' ? `${int(1, 90)} ${street}` : `${street} ${int(1, 90)}`,
				city,
				region,
				postcode,
				country,
			}
		}
	}
	const invalid: [Company, InvalidReason][] = [
		[at(topA, 0), 'missing_line1'],
		[at(topA, 1), 'invalid_postcode'],
		[at(topC, 0), 'missing_city'],
		[at(restA, 2), 'missing_postcode'],
		[unsupportedCountry, 'unsupported_country'],
	]
	for (const [company, reason] of invalid) {
		company.invalid = reason
		if (reason === 'missing_line1') company.address.line1 = null
		if (reason === 'missing_city') company.address.city = null
		if (reason === 'missing_postcode') company.address.postcode = null
		if (reason === 'invalid_postcode') company.address.postcode = company.address.postcode!.slice(0, -2)
	}

	// 6. Duplicate quirks: conflicting headcounts, a missing domain on one side, stale FactSet financials.
	for (const company of [
		at(topAF, 1),
		at(topAF, 2),
		at(topAC, 1),
		at(topCF, 0),
		at(restAF, 0),
		at(restCF, 0),
		at(nontargetAF, 0),
	]) {
		company.headcountConflict = { loserFactor: pick([0.6, 0.7, 1.3, 1.45]) }
		company.tricks.push('headcount conflict')
		if (company.headcount === null) company.headcount = int(60, 800)
	}
	// No random draws here, so every other fixture stays byte for byte the same.
	for (const [company, provider] of [
		[at(topAC, 0), 'clay'],
		[at(restAF, 0), 'apollo'],
	] as const) {
		company.addressConflict = { provider, line1: '2 Old Station Yard' }
		company.tricks.push(`old office address at ${provider}`)
	}
	for (const [company, provider] of [
		[at(topAF, 3), 'factset'],
		[at(restAF, 1), 'factset'],
		[at(topCF, 1), 'factset'],
		[at(nontargetAC, 0), 'apollo'],
	] as const) {
		company.missingDomainOn = provider
		company.tricks.push(`no domain at ${provider}: matched on name + country`)
	}
	const staleFactset = [
		at(topAF, 4),
		at(topCF, 0),
		...companies.filter((company) => company.tier === 'unknown').slice(0, 4),
	]
	for (const company of staleFactset) company.staleFactset = true

	// 7. People. The intended recipient always outranks colleagues on function, so the expected choice is unambiguous.
	const usedNames = new Set<string>()
	function newPerson(company: Company, func: Func, seniority: Seniority, intended: boolean): Person {
		let first = pick(FIRST_NAMES)
		let last = pick(LAST_NAMES)
		while (usedNames.has(`${first} ${last}`)) {
			first = pick(FIRST_NAMES)
			last = pick(LAST_NAMES)
		}
		usedNames.add(`${first} ${last}`)
		const local = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '')
		const person: Person = {
			first,
			last,
			title: pick(TITLES[func][seniority]!),
			func,
			seniority,
			email: `${local}@${company.domain}`,
			providers: [pick(company.providers)],
			intended,
		}
		company.persons.push(person)
		return person
	}
	const senioritiesFor = (func: Func) => Object.keys(TITLES[func]) as Seniority[]
	for (const company of companies) {
		if (isTop(company) || isRest(company)) {
			const func = isTop(company)
				? pick(['operations', 'operations', 'operations', 'fleet', 'fleet'] as const)
				: pick(FUNC_RANK.slice(0, 4))
			const intended = newPerson(company, func, pick(senioritiesFor(func)), true)
			const lower = FUNC_RANK.slice(FUNC_RANK.indexOf(intended.func) + 1)
			for (let i = isTop(company) ? int(2, 3) : int(0, 2); i > 0; i--) {
				const colleagueFunc = pick(lower)
				newPerson(company, colleagueFunc, pick(senioritiesFor(colleagueFunc)), false)
			}
		} else {
			const func = pick(FUNC_RANK)
			newPerson(company, func, pick(senioritiesFor(func)), false)
		}
	}
	const intendedOf = (company: Company) => company.persons.find((person) => person.intended)!
	const tieBreaks: Manifest['recipientTieBreaks'] = []
	function forceIntended(company: Company, func: Func, seniority: Seniority) {
		const person = intendedOf(company)
		person.func = func
		person.seniority = seniority
		person.title = TITLES[func][seniority]![0]!
		company.persons = company.persons.filter(
			(other) => other.intended || FUNC_RANK.indexOf(other.func) > FUNC_RANK.indexOf(func),
		)
		return person
	}

	// Same function, different seniority: the director wins over the head.
	const seniorityCase = at(topA, 2)
	const director = forceIntended(seniorityCase, 'operations', 'director')
	const head = newPerson(seniorityCase, 'operations', 'head', false)
	head.title = 'Head of Operations'
	tieBreaks.push({ companyKey: seniorityCase.key, rule: 'seniority', winner: director.email, loser: head.email })

	// Same function and seniority: the person both providers know wins.
	const corroborationCase = at(topAC, 0)
	const corroborated = forceIntended(corroborationCase, 'operations', 'director')
	corroborated.providers = ['apollo', 'clay']
	const rival = newPerson(corroborationCase, 'operations', 'director', false)
	rival.providers = ['apollo']
	tieBreaks.push({
		companyKey: corroborationCase.key,
		rule: 'corroboration',
		winner: corroborated.email,
		loser: rival.email,
	})

	// The same person at two providers; one spells the email with capitals.
	const viaDuplicate = at(topAF, 0)
	const duplicatePeople = [viaDuplicate, at(topAF, 1), at(topAC, 2), at(restAF, 0), at(restCF, 0)].map((company) => {
		const person = intendedOf(company)
		person.providers = [...company.providers]
		return person
	})
	duplicatePeople.push(corroborated)
	const capitalised = intendedOf(viaDuplicate)
	const [local, domain] = capitalised.email.split('@') as [string, string]
	capitalised.emailVariant = {
		provider: 'factset',
		email: `${local
			.split('.')
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join('.')}@${domain}`,
	}

	// Fill up to exactly 600 contact records with colleagues who are never a target function.
	const contactRecords = () =>
		companies.reduce((sum, company) => sum + company.persons.reduce((n, person) => n + person.providers.length, 0), 0)
	while (contactRecords() < 600) {
		const company = pick(companies)
		newPerson(company, 'other', pick(senioritiesFor('other')), false)
	}
	if (contactRecords() !== 600) throw new Error(`contact records: ${contactRecords()}`)

	// 8. Suppression: opt-outs and the pilot mailing, inside and outside the top 50.
	const optOutCompanies = [
		viaDuplicate,
		at(topA, 3),
		at(topA, 4),
		at(topC, 1),
		at(topAF, 2),
		at(restA, 0),
		at(restC, 0),
	]
	const pilotCompanies = [at(topA, 5), at(topC, 2), at(topCF, 1), at(restA, 1), at(restC, 1)]
	const suppressedEmails = new Set([...optOutCompanies, ...pilotCompanies].map((company) => intendedOf(company).email))

	// 9. Provider records.
	const apolloOrgs: Record<string, unknown>[] = []
	const apolloPeople: Record<string, unknown>[] = []
	const factsetEntities: Record<string, unknown>[] = []
	const factsetFundamentals: Record<string, unknown>[] = []
	const factsetPeople: Record<string, unknown>[] = []
	const clayCompanies: Record<string, unknown>[] = []
	const clayPeople: Record<string, unknown>[] = []

	const headcountAt = (company: Company, provider: Provider) => {
		if (company.headcount === null) return null
		// Precedence for headcount is FactSet, Apollo, Clay: the winner carries the true value.
		const winner = (['factset', 'apollo', 'clay'] as const).find((p) => company.providers.includes(p))
		if (provider === winner) return company.headcount
		const factor = company.headcountConflict?.loserFactor ?? 0.97 + rng() * 0.06
		return Math.max(1, Math.round(company.headcount * factor))
	}
	const printed = (usd: number) => (usd >= 1e9 ? `${(usd / 1e9).toFixed(1)}B` : `${(usd / 1e6).toFixed(1)}M`)
	const domainForms = ['https://www.{d}/', 'www.{d}', 'http://{d}/', '{D}']
	let domainTrick = 0
	const trickyDomain = (company: Company) => {
		const form = at(domainForms, domainTrick++ % domainForms.length)
		company.tricks.push(`domain written as ${form}`)
		return form.replace('{d}', company.domain).replace('{D}', company.domain.toUpperCase())
	}
	const addressAt = (company: Company, provider: Provider): Address =>
		company.addressConflict?.provider === provider
			? { ...company.address, line1: company.addressConflict.line1 }
			: company.address
	const ukPhone = () => `+44 113 496 0${String(int(0, 999)).padStart(3, '0')}`

	for (const company of companies) {
		const name = `${company.base} ${company.legal}`
		const duplicate = isDuplicate(company)

		if (company.providers.includes('apollo')) {
			const id = hex(24)
			company.ids.apollo = id
			const noDomain = company.missingDomainOn === 'apollo'
			const address = addressAt(company, 'apollo')
			const usd = company.revenueGbp === null ? null : Math.round(company.revenueGbp / FX.USD!)
			apolloOrgs.push({
				id,
				name,
				website_url: noDomain ? null : `http://www.${company.domain}`,
				primary_domain: noDomain ? null : company.domain,
				linkedin_url: `http://www.linkedin.com/company/${slug(company.base)}`,
				founded_year: int(1955, 2019),
				estimated_num_employees: headcountAt(company, 'apollo'),
				annual_revenue: usd,
				annual_revenue_printed: usd === null ? null : printed(usd),
				industry: INDUSTRY_LABELS[company.industry]!.apollo,
				industries: [INDUSTRY_LABELS[company.industry]!.apollo],
				street_address: address.line1,
				city: address.city,
				state: address.region,
				postal_code: address.postcode,
				country: COUNTRY_NAMES[company.country].apollo,
				raw_address: [
					address.line1,
					address.city,
					address.region,
					address.postcode,
					COUNTRY_NAMES[company.country].apollo,
				]
					.filter(Boolean)
					.join(', '),
				technology_names: [
					'Microsoft Office 365',
					'Google Analytics',
					...(company.signals.includes('fleet_telematics') ? [pick(['Geotab', 'Samsara'])] : []),
				],
				total_funding: company.signals.includes('funded') ? roundTo(int(2_000_000, 40_000_000), 100_000) : null,
				latest_funding_stage: company.signals.includes('funded')
					? pick(['Series A', 'Series B', 'Private Equity'])
					: null,
				latest_funding_round_date: company.signals.includes('funded') ? `20${int(18, 24)}-0${int(1, 9)}-01` : null,
				funding_events: [],
			})
		}

		if (company.providers.includes('factset')) {
			const fsymId = `${alnum(6)}-E`
			company.ids.factset = fsymId
			const address = addressAt(company, 'factset')
			const swapped = ({ Ltd: 'Limited', Limited: 'Ltd' } as Record<string, string>)[company.legal]
			const nameForm = duplicate ? pick([swapped ? 'swap' : 'upper', 'upper']) : 'plain'
			const proper =
				nameForm === 'swap' ? `${company.base} ${swapped}` : nameForm === 'upper' ? name.toUpperCase() : name
			if (nameForm === 'swap') company.tricks.push(`${company.legal} vs ${swapped}`)
			if (nameForm === 'upper') company.tricks.push('name in capitals')
			factsetEntities.push({
				fsym_id: fsymId,
				entity_proper_name: proper,
				fsym_entity_id: fsymId,
				ultimate_parent_id: fsymId,
				ultimate_parent_name: proper,
				private_entity_flag: company.legal === 'PLC' ? 0 : 1,
				public_entity_flag: company.legal === 'PLC' ? 1 : 0,
				website:
					company.missingDomainOn === 'factset' ? null : duplicate ? trickyDomain(company) : `www.${company.domain}`,
				incorporation_country: company.country,
				country_of_risk: company.country,
				business_description: `${company.base} ${DESCRIPTIONS[company.industry]}.`,
				headquarters_street: address.line1,
				headquarters_city: address.city,
				headquarters_state: address.region,
				headquarters_zip: address.postcode,
				headquarters_country: company.country,
			})
			const fiscalEndDate = company.staleFactset ? '2024-03-31' : pick(['2025-12-31', '2026-03-31', '2026-06-30'])
			const fiscal = {
				periodicity: 'ANN',
				fiscal_year: Number(fiscalEndDate.slice(0, 4)),
				fiscal_end_date: fiscalEndDate,
			}
			const headcount = headcountAt(company, 'factset')
			if (headcount !== null)
				factsetFundamentals.push({ fsym_id: fsymId, metric: 'FF_EMP', ...fiscal, currency: null, value: headcount })
			if (company.revenueGbp !== null) {
				const currency = CURRENCY[company.country]
				const millions = Math.round(company.revenueGbp / FX[currency]! / 1000) / 1000
				factsetFundamentals.push({ fsym_id: fsymId, metric: 'FF_SALES', ...fiscal, currency, value: millions })
			}
		}

		if (company.providers.includes('clay')) {
			const domainCell = duplicate && company.providers.includes('apollo') ? trickyDomain(company) : company.domain
			company.ids.clay = domainCell.trim().toLowerCase()
			const address = addressAt(company, 'clay')
			clayCompanies.push({
				'Company Name': duplicate && chance(0.5) ? company.base.toUpperCase() : company.base,
				Domain: domainCell,
				Industry: INDUSTRY_LABELS[company.industry]!.clay,
				'Employee Count': headcountAt(company, 'clay'),
				'Annual Revenue (GBP)': company.revenueGbp,
				'Street Address': address.line1?.replace(/,/g, '') ?? null,
				City: address.city,
				Postcode: address.postcode,
				Country: COUNTRY_NAMES[company.country].clay,
				'Net Zero Target': company.signals.includes('net_zero_target') ? String(pick([2030, 2035, 2040])) : null,
				'LinkedIn URL': `https://www.linkedin.com/company/${slug(company.base)}`,
				'Enriched At': `2026-${pick(['09', '10', '11'])}-${String(int(1, 18)).padStart(2, '0')}T09:00:00Z`,
				'Company Enrichment': {
					founded: int(1955, 2019),
					description: `${company.base} ${DESCRIPTIONS[company.industry]}.`,
				},
			})
		}

		for (const person of company.persons) {
			const fullName = `${person.first} ${person.last}`
			const emailFor = (provider: Provider) =>
				person.emailVariant?.provider === provider ? person.emailVariant.email : person.email
			if (person.providers.includes('apollo')) {
				const fn = APOLLO_FUNCTION[person.func]
				apolloPeople.push({
					id: hex(24),
					first_name: person.first,
					last_name: person.last,
					name: fullName,
					title: person.title,
					headline: `${person.title} at ${company.base}`,
					seniority: person.seniority === 'other' ? 'senior' : person.seniority,
					departments: fn.departments,
					subdepartments: [],
					functions: fn.functions,
					email: emailFor('apollo'),
					email_status: chance(0.8) ? 'verified' : 'guessed',
					linkedin_url: `http://www.linkedin.com/in/${slug(person.first)}-${slug(person.last)}-${hex(4)}`,
					city: company.address.city,
					state: company.address.region,
					country: COUNTRY_NAMES[company.country].apollo,
					organization_id: company.ids.apollo,
					employment_history: [
						{
							organization_name: company.base,
							title: person.title,
							current: true,
							start_date: `20${int(10, 25)}-0${int(1, 9)}-01`,
						},
					],
					organization: {
						id: company.ids.apollo,
						name,
						primary_domain: company.missingDomainOn === 'apollo' ? null : company.domain,
					},
				})
			}
			if (person.providers.includes('factset')) {
				factsetPeople.push({
					fsym_id: company.ids.factset,
					person_id: `${alnum(6)}-P`,
					name: fullName,
					title: person.title,
					job_function1: FACTSET_FUNCTION[person.func],
					job_function2: null,
					job_function3: null,
					job_function4: null,
					email: emailFor('factset'),
					phone: ukPhone(),
					main_phone: ukPhone(),
				})
			}
			if (person.providers.includes('clay')) {
				clayPeople.push({
					'Full Name': fullName,
					'First Name': person.first,
					'Last Name': person.last,
					'Job Title': person.title,
					'Work Email': emailFor('clay'),
					'LinkedIn Profile': `https://www.linkedin.com/in/${slug(person.first)}-${slug(person.last)}-${hex(4)}`,
					'Company Name': company.base,
					'Company Domain': company.domain,
					'Person Enrichment': {
						seniority: CLAY_SENIORITY[person.seniority],
						department: CLAY_DEPARTMENT[person.func],
						location: `${company.address.city ?? ''}, ${COUNTRY_NAMES[company.country].clay}`,
					},
				})
			}
		}
	}

	// Malformed records the ingestion must reject and report. They are not part of the 300/600.
	const malformed: Manifest['malformed'] = [
		{ provider: 'apollo', kind: 'company', problem: 'organization without a name or domain' },
		{ provider: 'clay', kind: 'contact', problem: 'person row whose Work Email is "not found"' },
		{ provider: 'factset', kind: 'fundamental', problem: 'FF_EMP value "N/A" instead of a number' },
	]
	apolloOrgs.push({
		id: hex(24),
		name: null,
		website_url: null,
		primary_domain: null,
		estimated_num_employees: null,
		annual_revenue: null,
		industry: null,
		country: 'United Kingdom',
	})
	const clayHost = at(restC, 5)
	clayPeople.push({
		'Full Name': 'Pat Example',
		'First Name': 'Pat',
		'Last Name': 'Example',
		'Job Title': 'Operations Manager',
		'Work Email': 'not found',
		'LinkedIn Profile': null,
		'Company Name': clayHost.base,
		'Company Domain': clayHost.domain,
		'Person Enrichment': { seniority: 'Manager', department: 'Operations', location: null },
	})
	const brokenFundamental = companies.find((company) => company.tier === 'unknown' && !company.staleFactset)!
	factsetFundamentals.push({
		fsym_id: brokenFundamental.ids.factset,
		metric: 'FF_EMP',
		periodicity: 'ANN',
		fiscal_year: 2023,
		fiscal_end_date: '2023-03-31',
		currency: null,
		value: 'N/A',
	})

	// 10. Seed-owned history: opt-outs, the pilot mailing 45 days ago and a historical campaign 120 days ago.
	const optOutSources = ['unsubscribe link', 'email reply', 'phone call']
	const optOuts = optOutCompanies.map((company) => {
		const person = intendedOf(company)
		return {
			email: company === viaDuplicate ? person.emailVariant!.email : person.email,
			daysAgo: int(5, 80),
			source: pick(optOutSources),
		}
	})
	const pilotCards = pilotCompanies.map((company) => ({
		email: intendedOf(company).email,
		companyDomain: company.domain,
		status: 'delivered',
	}))
	const invalidSet = new Set(invalid.map(([company]) => company))
	const historicalPool = (list: Company[]) =>
		list.filter((company) => !invalidSet.has(company) && !suppressedEmails.has(intendedOf(company).email))
	const historicalCompanies = [
		...historicalPool(companies.filter(isTop)).slice(0, 8),
		...historicalPool(companies.filter(isRest)).slice(0, 32),
	]
	const returned = new Set([at(historicalCompanies, 11), at(historicalCompanies, 30)])
	const historicalCards = historicalCompanies.map((company, index) => ({
		email: intendedOf(company).email,
		companyDomain: company.domain,
		variant: index % 2 === 0 ? 'A' : 'B',
		status: returned.has(company) ? 'returned' : 'delivered',
	}))
	type Outcome = {
		kind: 'reply' | 'visit' | 'meeting'
		card?: string
		domain: string
		personEmail?: string
		dayOffset?: number
		daysAgo?: number
		source: string
	}
	const outcomes: Outcome[] = []
	const delivered = historicalCards.filter((card) => card.status === 'delivered')
	for (const card of delivered) {
		if (chance(0.45))
			outcomes.push({
				kind: 'visit',
				card: card.email,
				domain: card.companyDomain,
				dayOffset: int(3, 25),
				source: 'web analytics',
			})
		if (chance(0.15))
			outcomes.push({
				kind: 'reply',
				card: card.email,
				domain: card.companyDomain,
				personEmail: card.email,
				dayOffset: int(5, 20),
				source: 'inbox',
			})
		if (chance(0.08))
			outcomes.push({
				kind: 'meeting',
				card: card.email,
				domain: card.companyDomain,
				personEmail: card.email,
				dayOffset: int(10, 25),
				source: 'calendar',
			})
	}
	// Day 35 is outside the 30-day window: these must never be attributed.
	for (const [kind, card] of [
		['visit', at(delivered, 1)],
		['reply', at(delivered, 2)],
		['meeting', at(delivered, 3)],
	] as const) {
		outcomes.push({
			kind,
			card: card.email,
			domain: card.companyDomain,
			...(kind === 'visit' ? {} : { personEmail: card.email }),
			dayOffset: 35,
			source: 'late',
		})
	}
	outcomes.push({
		kind: 'visit',
		domain: at(
			companies.filter((company) => company.tier === 'nontarget'),
			0,
		).domain,
		daysAgo: 20,
		source: 'web analytics',
	})

	// 11. Manifest.
	const recordsOf = (company: Company): ProviderRecord[] =>
		company.providers.map((provider) => ({ provider, externalId: company.ids[provider]! }))
	const scoreOf = (company: Company) => {
		const inProfile =
			TARGET_INDUSTRIES.includes(company.industry) &&
			company.tier !== 'unknown' &&
			['GB', 'IE'].includes(company.country)
		if (!inProfile) return null
		const headcountOk = company.headcount !== null && company.headcount >= 50 && company.headcount <= 5000
		const revenueOk = company.revenueGbp !== null && company.revenueGbp >= 10_000_000
		return 50 + (headcountOk ? 20 : 0) + (revenueOk ? 20 : 0) + (company.signals.length ? 10 : 0)
	}
	const top50 = companies.filter(isTop)
	const nextBestScore = Math.max(
		...companies.filter((company) => !isTop(company)).map((company) => scoreOf(company) ?? 0),
	)
	const optOutSet = new Set(optOutCompanies)
	const pilotSet = new Set(pilotCompanies)
	const expectedFor = (company: Company) =>
		optOutSet.has(company)
			? 'suppressed:opt_out'
			: pilotSet.has(company)
				? 'suppressed:mailed_90d'
				: company.invalid
					? `invalid_address:${company.invalid}`
					: 'eligible'

	const byVariant = (variant: 'A' | 'B') => {
		const cards = historicalCards.filter((card) => card.variant === variant)
		const emails = new Set(cards.map((card) => card.email))
		const inWindow = (kind: Outcome['kind']) =>
			outcomes.filter(
				(outcome) =>
					outcome.kind === kind && outcome.card && emails.has(outcome.card) && (outcome.dayOffset ?? 99) <= 30,
			).length
		return {
			sent: cards.length,
			delivered: cards.filter((card) => card.status === 'delivered').length,
			returned: cards.filter((card) => card.status === 'returned').length,
			replies: inWindow('reply'),
			visits: inWindow('visit'),
			meetings: inWindow('meeting'),
		}
	}

	const manifest: Manifest = {
		version: 1,
		anchor: FIXTURE_ANCHOR,
		counts: {
			companyRecords: apolloOrgs.length + factsetEntities.length + clayCompanies.length - 1,
			contactRecords: apolloPeople.length + factsetPeople.length + clayPeople.length - 1,
			uniqueCompanies: companies.length,
			duplicateCompanies: companies.filter(isDuplicate).length,
			duplicateContacts: duplicatePeople.length,
			headcountConflicts: companies.filter((company) => company.headcountConflict).length,
			addressConflicts: companies.filter((company) => company.addressConflict).length,
			suppressed: optOuts.length + pilotCards.length,
			optOuts: optOuts.length,
			pilotMailed: pilotCards.length,
			invalidAddresses: invalid.length,
			byProvider: {
				apollo: { companies: apolloOrgs.length - 1, contacts: apolloPeople.length },
				factset: { companies: factsetEntities.length, contacts: factsetPeople.length },
				clay: { companies: clayCompanies.length, contacts: clayPeople.length - 1 },
			},
		},
		duplicates: companies.filter(isDuplicate).map((company) => ({
			companyKey: company.key,
			name: `${company.base} ${company.legal}`,
			domain: company.domain,
			records: recordsOf(company),
			tricks: [
				`country written as ${company.providers.map((p) => (p === 'factset' ? company.country : COUNTRY_NAMES[company.country][p])).join(' vs ')}`,
				...company.tricks,
			],
		})),
		nearDuplicates: nearPairs.map((pair) => ({
			companies: pair.map((company) => ({
				companyKey: company.key,
				name: `${company.base} ${company.legal}`,
				country: company.country,
				domain: company.domain,
				records: recordsOf(company),
			})),
		})),
		headcountConflicts: companies
			.filter((company) => company.headcountConflict)
			.map((company) => ({
				companyKey: company.key,
				values: company.providers.map((provider) => ({ provider, headcount: headcountAt(company, provider)! })),
			})),
		addressConflicts: companies
			.filter((company) => company.addressConflict)
			.map((company) => ({
				companyKey: company.key,
				inTop50: isTop(company),
				values: company.providers.map((provider) => ({ provider, line1: addressAt(company, provider).line1 })),
			})),
		suppressed: [
			...optOutCompanies.map((company) => ({ company, reason: 'opt_out' as const })),
			...pilotCompanies.map((company) => ({ company, reason: 'mailed_90d' as const })),
		].map(({ company, reason }) => ({
			personKey: intendedOf(company).email,
			reason,
			companyKey: company.key,
			inTop50: isTop(company),
			viaDuplicateContact: company === viaDuplicate,
		})),
		invalidAddresses: invalid.map(([company, reason]) => ({
			companyKey: company.key,
			reason,
			inTop50: isTop(company),
			records: recordsOf(company),
		})),
		top50: {
			expectedEligible: top50.filter((company) => expectedFor(company) === 'eligible').length,
			nextBestScore,
			companies: top50.map((company) => ({
				companyKey: company.key,
				name: `${company.base} ${company.legal}`,
				domain: company.domain,
				records: recordsOf(company),
				expectedScore: scoreOf(company)!,
				recipient: intendedOf(company).email,
				expected: expectedFor(company),
			})),
		},
		recipientTieBreaks: tieBreaks,
		staleFactset: staleFactset.map((company) => ({
			companyKey: company.key,
			fsymId: company.ids.factset!,
			fiscalEndDate: '2024-03-31',
		})),
		malformed,
		historical: {
			cards: historicalCards.length,
			byVariant: { A: byVariant('A'), B: byVariant('B') },
			outsideWindow: outcomes.filter((outcome) => (outcome.dayOffset ?? 0) > 30).length,
		},
	}

	return {
		'apollo/organizations.json': shuffle(apolloOrgs),
		'apollo/people.json': shuffle(apolloPeople),
		'factset/entity-references.json': shuffle(factsetEntities),
		'factset/fundamentals.json': {
			_comment:
				'FF_SALES is in millions of the reporting currency (an assumption: the FactSet model docs do not state the scale). FF_EMP is a head count.',
			data: shuffle(factsetFundamentals),
		},
		'factset/people.json': shuffle(factsetPeople),
		'clay/companies.json': shuffle(clayCompanies),
		'clay/people.json': shuffle(clayPeople),
		'fx-rates.json': FX_RATES,
		'history.json': {
			_comment:
				'Seed-owned data. daysAgo is relative to the moment the seed runs; dayOffset is relative to the card mailed_at.',
			optOuts,
			pilotCampaign: { name: 'Pilot: plant hire firms', daysAgo: 45, variant: 'A', cards: pilotCards },
			historicalCampaign: { name: 'Spring contractors push', daysAgo: 120, cards: historicalCards },
			outcomes,
		},
		'manifest.json': manifest,
	}
}

if (import.meta.main) {
	for (const [path, value] of Object.entries(generateFixtures())) {
		const file = `${FIXTURES_DIR}/${path}`
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(file, serialize(value))
	}
	console.log(`fixtures written to ${FIXTURES_DIR}`)
}
