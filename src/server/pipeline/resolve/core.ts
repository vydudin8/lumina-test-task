import {
	CONFLICT_RELATIVE_DIFFERENCE,
	FIELD_PRECEDENCE,
	INDUSTRY_MAP,
	STALE_AFTER_MONTHS,
	type FieldName,
	type ProviderName,
} from '#common/settings.ts'
import Decimal from 'decimal.js'
import { personKey } from '../../policy/person-key.ts'

type Row = Record<string, unknown>

export interface FxRate {
	id: number
	currency: string
	rate: string
	asOf: string
}

export interface Revenue {
	amount: string
	currency: string
	gbp: string
	fxRateId: number
	rate: string
	rateAsOf: string
}

export interface Address {
	line1: string | null
	city: string | null
	region: string | null
	postcode: string | null
	country: string | null
}

export interface SourceFields {
	name: string | null
	normalisedName: string | null
	domain: string | null
	country: string | null
	industry: string | null
	industryLabel: string | null
	headcount: number | null
	revenue: Revenue | null
	address: Address | null
	signals: string[]
	// The provider's own "as of" date per field, when it gives one.
	asOf: Partial<Record<FieldName, string>>
}

export interface SourceCompany extends SourceFields {
	id: number
	provider: ProviderName
	externalId: string
	rawRecordId: number
	fetchedAt: string
}

export interface Override {
	field: FieldName
	chosenSourceId: number
	createdBy: string
	reason: string
	at: string
}

export interface MatchDecision {
	a: number
	b: number
	decision: 'merge' | 'split'
}

// --- Normalisation ---------------------------------------------------------------------------------

const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

function whole(value: unknown) {
	const number = typeof value === 'string' ? Number(value.replace(/,/g, '')) : value
	return typeof number === 'number' && Number.isFinite(number) ? Math.round(number) : null
}

export function normaliseDomain(value: unknown) {
	const raw = text(value)?.toLowerCase()
	if (!raw) return null
	const host = raw
		.replace(/^[a-z]+:\/\//, '')
		.replace(/^www\./, '')
		.split('/')[0]
	return host || null
}

const LEGAL_SUFFIXES = new Set([
	'ltd',
	'limited',
	'plc',
	'gmbh',
	'ag',
	'sa',
	'sas',
	'bv',
	'dac',
	'llc',
	'inc',
	'teoranta',
])

export function normaliseName(value: unknown) {
	const raw = text(value)
	if (!raw) return null
	const words = raw
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/[^a-z0-9\s]/g, '')
		.split(/\s+/)
		.filter(Boolean)
	while (words.length > 1 && LEGAL_SUFFIXES.has(words.at(-1)!)) words.pop()
	return words.join(' ')
}

const COUNTRIES: Record<string, string> = {
	'united kingdom': 'GB',
	uk: 'GB',
	gb: 'GB',
	'great britain': 'GB',
	england: 'GB',
	scotland: 'GB',
	wales: 'GB',
	ireland: 'IE',
	'republic of ireland': 'IE',
	ie: 'IE',
	france: 'FR',
	fr: 'FR',
	germany: 'DE',
	deutschland: 'DE',
	de: 'DE',
	netherlands: 'NL',
	'the netherlands': 'NL',
	nl: 'NL',
	switzerland: 'CH',
	ch: 'CH',
}

export const normaliseCountry = (value: unknown) => COUNTRIES[text(value)?.toLowerCase() ?? ''] ?? null

const TELEMATICS_VENDORS = ['geotab', 'samsara', 'webfleet', 'verizon connect']

function toGbp(amount: Decimal, currency: string, fx: FxRate[]): Revenue | null {
	const rate = fx.filter((row) => row.currency === currency).sort((a, b) => b.asOf.localeCompare(a.asOf))[0]
	if (!rate) return null
	return {
		amount: amount.toString(),
		currency,
		gbp: amount.times(rate.rate).toString(),
		fxRateId: rate.id,
		rate: rate.rate,
		rateAsOf: rate.asOf,
	}
}

function address(parts: Address): Address | null {
	return Object.values(parts).some((part) => part !== null) ? parts : null
}

function industry(label: unknown) {
	const industryLabel = text(label)
	return { industry: industryLabel ? (INDUSTRY_MAP[industryLabel.toLowerCase()] ?? null) : null, industryLabel }
}

// Maps one provider record onto our fields. Nothing is inferred: a field the provider does not report stays null.
export function normaliseSource(provider: ProviderName, payload: Row, fx: FxRate[]): SourceFields {
	if (provider === 'apollo') {
		const country = normaliseCountry(payload.country)
		const technologies = Array.isArray(payload.technology_names)
			? payload.technology_names.map((name) => String(name).toLowerCase())
			: []
		return {
			name: text(payload.name),
			normalisedName: normaliseName(payload.name),
			domain: normaliseDomain(payload.primary_domain) ?? normaliseDomain(payload.website_url),
			country,
			...industry(payload.industry),
			headcount: whole(payload.estimated_num_employees),
			// Apollo gives no currency for annual_revenue; we treat it as USD (see README).
			revenue:
				typeof payload.annual_revenue === 'number' ? toGbp(new Decimal(payload.annual_revenue), 'USD', fx) : null,
			address: address({
				line1: text(payload.street_address),
				city: text(payload.city),
				region: text(payload.state),
				postcode: text(payload.postal_code),
				country,
			}),
			signals: [
				...(technologies.some((name) => TELEMATICS_VENDORS.includes(name)) ? ['fleet_telematics'] : []),
				...(typeof payload.total_funding === 'number' && payload.total_funding > 0 ? ['funded'] : []),
			],
			asOf: {},
		}
	}

	if (provider === 'factset') {
		const entity = (payload.entity_reference ?? {}) as Row
		const fundamentals = (Array.isArray(payload.fundamentals) ? payload.fundamentals : []) as Row[]
		const latest = (metric: string) =>
			fundamentals
				.filter((row) => row.metric === metric && typeof row.value === 'number')
				.sort((a, b) => String(b.fiscal_end_date).localeCompare(String(a.fiscal_end_date)))[0]
		const employees = latest('FF_EMP')
		const sales = latest('FF_SALES')
		const country = normaliseCountry(entity.headquarters_country) ?? normaliseCountry(entity.incorporation_country)
		const revenue =
			sales && text(sales.currency)
				? toGbp(new Decimal(sales.value as number).times(1_000_000), String(sales.currency), fx)
				: null
		return {
			name: text(entity.entity_proper_name),
			normalisedName: normaliseName(entity.entity_proper_name),
			domain: normaliseDomain(entity.website),
			country,
			industry: null,
			industryLabel: null,
			headcount: employees ? whole(employees.value) : null,
			revenue,
			address: address({
				line1: text(entity.headquarters_street),
				city: text(entity.headquarters_city),
				region: text(entity.headquarters_state),
				postcode: text(entity.headquarters_zip),
				country,
			}),
			signals: [],
			asOf: {
				...(employees && { headcount: String(employees.fiscal_end_date) }),
				...(revenue && sales && { revenue: String(sales.fiscal_end_date) }),
			},
		}
	}

	const country = normaliseCountry(payload.Country)
	const revenueGbp = payload['Annual Revenue (GBP)']
	const fields: SourceFields = {
		name: text(payload['Company Name']),
		normalisedName: normaliseName(payload['Company Name']),
		domain: normaliseDomain(payload.Domain),
		country,
		...industry(payload.Industry),
		headcount: whole(payload['Employee Count']),
		revenue: typeof revenueGbp === 'number' ? toGbp(new Decimal(revenueGbp), 'GBP', fx) : null,
		address: address({
			line1: text(payload['Street Address']),
			city: text(payload.City),
			region: null,
			postcode: text(payload.Postcode),
			country,
		}),
		signals: text(payload['Net Zero Target']) ? ['net_zero_target'] : [],
		asOf: {},
	}
	// Clay stamps the whole row with one enrichment time.
	const enrichedAt = text(payload['Enriched At'])?.slice(0, 10)
	if (enrichedAt) {
		for (const field of [
			'name',
			'domain',
			'country',
			'industry',
			'headcount',
			'revenue',
			'address',
			'signals',
		] as const) {
			const value =
				field === 'signals'
					? fields.signals.length || null
					: field === 'industry'
						? fields.industryLabel
						: fields[field]
			if (value !== null) fields.asOf[field] = enrichedAt
		}
	}
	return fields
}

// --- Matching ----------------------------------------------------------------------------------------

export interface PossibleDuplicate {
	a: number
	b: number
	reason: 'same name, different country' | 'same name, different domain' | 'split by a person'
}

const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`)

type Matchable = Pick<SourceCompany, 'id' | 'normalisedName' | 'domain' | 'country'>

// Union-find over three kinds of edges, strongest first: manual merges, equal domains, equal name + country.
// Two groups are never joined automatically if that would put two different domains, or a split pair, together.
export function cluster(sources: Matchable[], decisions: MatchDecision[]) {
	const sorted = [...sources].sort((a, b) => a.id - b.id)
	const byId = new Map(sorted.map((source) => [source.id, source]))
	const root = new Map(sorted.map((source) => [source.id, source.id]))
	const members = new Map(sorted.map((source) => [source.id, [source.id]]))
	const splits = new Set(decisions.filter((d) => d.decision === 'split').map((d) => pairKey(d.a, d.b)))

	const find = (id: number): number => {
		const parent = root.get(id)!
		if (parent === id) return id
		const top = find(parent)
		root.set(id, top)
		return top
	}

	function join(x: number, y: number, manual: boolean) {
		const [rx, ry] = [find(x), find(y)]
		if (rx === ry) return
		const [mx, my] = [members.get(rx)!, members.get(ry)!]
		if (mx.some((a) => my.some((b) => splits.has(pairKey(a, b))))) return
		if (!manual) {
			const domains = new Set([...mx, ...my].map((id) => byId.get(id)!.domain).filter(Boolean))
			if (domains.size > 1) return
		}
		const [keep, drop] = rx < ry ? [rx, ry] : [ry, rx]
		root.set(drop, keep)
		members.set(
			keep,
			[...members.get(keep)!, ...members.get(drop)!].sort((a, b) => a - b),
		)
		members.delete(drop)
	}

	for (const decision of decisions) {
		if (decision.decision === 'merge' && byId.has(decision.a) && byId.has(decision.b))
			join(decision.a, decision.b, true)
	}

	const groupBy = (key: (source: Matchable) => string | null) => {
		const groups = new Map<string, Matchable[]>()
		for (const source of sorted) {
			const value = key(source)
			if (value) groups.set(value, [...(groups.get(value) ?? []), source])
		}
		return [...groups.values()]
	}

	for (const sameDomain of groupBy((source) => source.domain)) {
		for (const source of sameDomain.slice(1)) join(sameDomain[0]!.id, source.id, false)
	}
	for (const sameName of groupBy((source) =>
		source.normalisedName && source.country ? `${source.normalisedName}|${source.country}` : null,
	)) {
		for (const [i, a] of sameName.entries()) {
			for (const b of sameName.slice(i + 1)) {
				if (!a.domain || !b.domain || a.domain === b.domain) join(a.id, b.id, false)
			}
		}
	}

	const possible = new Map<string, PossibleDuplicate>()
	for (const decision of decisions) {
		if (
			decision.decision === 'split' &&
			byId.has(decision.a) &&
			byId.has(decision.b) &&
			find(decision.a) !== find(decision.b)
		) {
			const [a, b] = decision.a < decision.b ? [decision.a, decision.b] : [decision.b, decision.a]
			possible.set(pairKey(a, b), { a, b, reason: 'split by a person' })
		}
	}
	for (const sameName of groupBy((source) => source.normalisedName)) {
		for (const [i, a] of sameName.entries()) {
			for (const b of sameName.slice(i + 1)) {
				if (find(a.id) === find(b.id) || possible.has(pairKey(a.id, b.id))) continue
				possible.set(pairKey(a.id, b.id), {
					a: a.id,
					b: b.id,
					reason: a.country !== b.country ? 'same name, different country' : 'same name, different domain',
				})
			}
		}
	}

	return {
		groups: [...members.values()].sort((a, b) => a[0]! - b[0]!),
		possibleDuplicates: [...possible.values()].sort((x, y) => x.a - y.a || x.b - y.b),
	}
}

// --- Field resolution --------------------------------------------------------------------------------

export interface Candidate<T> {
	sourceId: number
	provider: ProviderName
	rawRecordId: number
	value: T
	asOf: string | null
}

export interface ResolvedField<T> {
	value: T | null
	sourceId: number | null
	provider: ProviderName | null
	rawRecordId: number | null
	fetchedAt: string | null
	asOf: string | null
	stale: boolean
	conflict: boolean
	candidates: Candidate<T>[]
	override: Override | null
}

export interface ResolvedFields {
	name: ResolvedField<string>
	domain: ResolvedField<string>
	country: ResolvedField<string>
	industry: ResolvedField<string>
	headcount: ResolvedField<number>
	revenue: ResolvedField<Revenue>
	address: ResolvedField<Address>
	signals: ResolvedField<string[]>
}

const relativeConflict = (values: Decimal[]) => {
	if (values.length < 2) return false
	const max = Decimal.max(...values)
	const min = Decimal.min(...values)
	return max.gt(0) && max.minus(min).div(max).gt(CONFLICT_RELATIVE_DIFFERENCE)
}

const addressKey = (value: Address) =>
	[value.line1, value.city, value.postcode?.replace(/\s/g, ''), value.country]
		.map((part) => (part ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''))
		.join('|')

const CONFLICT_RULES: { [K in keyof ResolvedFields]: (values: NonNullable<ResolvedFields[K]['value']>[]) => boolean } =
	{
		name: () => false,
		domain: () => false,
		country: (values) => new Set(values).size > 1,
		industry: (values) => new Set(values).size > 1,
		headcount: (values) => relativeConflict(values.map((value) => new Decimal(value))),
		revenue: (values) => relativeConflict(values.map((value) => new Decimal(value.gbp))),
		address: (values) => new Set(values.map(addressKey)).size > 1,
		signals: () => false,
	}

export function staleBefore(now: Date) {
	const threshold = new Date(now)
	threshold.setUTCMonth(threshold.getUTCMonth() - STALE_AFTER_MONTHS)
	return threshold.toISOString().slice(0, 10)
}

// Picks each field from the highest-precedence source that has it, unless a person overrode it.
export function resolveFields(sources: SourceCompany[], overrides: Override[], now: Date): ResolvedFields {
	const threshold = staleBefore(now)
	const resolveOne = <K extends keyof ResolvedFields>(field: K): ResolvedFields[K] => {
		type T = NonNullable<ResolvedFields[K]['value']>
		const precedence: ProviderName[] =
			field === 'signals' ? ['apollo', 'clay', 'factset'] : FIELD_PRECEDENCE[field as Exclude<K, 'signals'>]
		const candidates: Candidate<T>[] = sources
			.filter((source) => (field === 'signals' ? source.signals.length > 0 : source[field] !== null))
			.sort((a, b) => precedence.indexOf(a.provider) - precedence.indexOf(b.provider) || a.id - b.id)
			.map((source) => ({
				sourceId: source.id,
				provider: source.provider,
				rawRecordId: source.rawRecordId,
				value: source[field] as T,
				asOf: source.asOf[field] ?? null,
			}))

		const override = overrides
			.filter(
				(candidate) => candidate.field === field && candidates.some((c) => c.sourceId === candidate.chosenSourceId),
			)
			.sort((a, b) => b.at.localeCompare(a.at))[0]
		const winner = override
			? candidates.find((candidate) => candidate.sourceId === override.chosenSourceId)
			: candidates[0]
		const source = winner && sources.find((candidate) => candidate.id === winner.sourceId)
		const value =
			field === 'signals'
				? [...new Set(candidates.flatMap((candidate) => candidate.value as string[]))].sort()
				: (winner?.value ?? null)

		return {
			value: field === 'signals' && (value as string[]).length === 0 ? null : value,
			sourceId: field === 'signals' ? null : (winner?.sourceId ?? null),
			provider: field === 'signals' ? null : (winner?.provider ?? null),
			rawRecordId: field === 'signals' ? null : (winner?.rawRecordId ?? null),
			fetchedAt: field === 'signals' ? null : (source?.fetchedAt ?? null),
			asOf: winner?.asOf ?? null,
			stale: Boolean(winner?.asOf && winner.asOf < threshold),
			conflict: CONFLICT_RULES[field](candidates.map((candidate) => candidate.value)),
			candidates,
			override: override ?? null,
		} as ResolvedFields[K]
	}

	return {
		name: resolveOne('name'),
		domain: resolveOne('domain'),
		country: resolveOne('country'),
		industry: resolveOne('industry'),
		headcount: resolveOne('headcount'),
		revenue: resolveOne('revenue'),
		address: resolveOne('address'),
		signals: resolveOne('signals'),
	}
}

// --- Contacts ----------------------------------------------------------------------------------------

export const SENIORITIES = ['c_suite', 'vp', 'director', 'head', 'manager', 'other'] as const
export type Seniority = (typeof SENIORITIES)[number]

export function seniorityFromTitle(title: string | null): Seniority {
	const lower = (title ?? '').toLowerCase()
	if (/\bchief\b.*\bofficer\b|^c[eofot]o\b/.test(lower)) return 'c_suite'
	if (/\bvp\b|vice president/.test(lower)) return 'vp'
	if (/\bdirector\b/.test(lower)) return 'director'
	if (/\bhead of\b/.test(lower)) return 'head'
	if (/\bmanager\b/.test(lower)) return 'manager'
	return 'other'
}

const PROVIDER_SENIORITY: Record<string, Seniority> = {
	c_suite: 'c_suite',
	'c-suite': 'c_suite',
	owner: 'c_suite',
	founder: 'c_suite',
	partner: 'c_suite',
	vp: 'vp',
	director: 'director',
	head: 'head',
	manager: 'manager',
}

export interface ContactFields {
	personKey: string
	firstName: string | null
	lastName: string | null
	fullName: string | null
	title: string | null
	seniority: Seniority
	functions: string[]
	emailStatus: string | null
	// Apollo organization id, FactSet fsym_id or the Clay company domain, depending on the provider.
	companyRef: string | null
}

const lowerList = (values: unknown[]) =>
	values
		.map(text)
		.filter((value): value is string => value !== null)
		.map((value) => value.toLowerCase())
const seniorityOf = (given: unknown, title: string | null) =>
	PROVIDER_SENIORITY[text(given)?.toLowerCase() ?? ''] ?? seniorityFromTitle(title)

export function normaliseContact(provider: ProviderName, payload: Row): ContactFields {
	if (provider === 'apollo') {
		const title = text(payload.title)
		return {
			personKey: personKey(String(payload.email)),
			firstName: text(payload.first_name),
			lastName: text(payload.last_name),
			fullName: text(payload.name),
			title,
			seniority: seniorityOf(payload.seniority, title),
			functions: lowerList([
				...((payload.functions as unknown[]) ?? []),
				...((payload.departments as unknown[]) ?? []),
			]),
			emailStatus: text(payload.email_status),
			companyRef: text(payload.organization_id),
		}
	}
	if (provider === 'factset') {
		const fullName = text(payload.name)
		const [firstName = null, ...rest] = fullName?.split(/\s+/) ?? []
		const title = text(payload.title)
		return {
			personKey: personKey(String(payload.email)),
			firstName,
			lastName: rest.join(' ') || null,
			fullName,
			title,
			seniority: seniorityFromTitle(title),
			functions: lowerList([
				payload.job_function1,
				payload.job_function2,
				payload.job_function3,
				payload.job_function4,
			]),
			emailStatus: null,
			companyRef: text(payload.fsym_id),
		}
	}
	const enrichment = (payload['Person Enrichment'] ?? {}) as Row
	const title = text(payload['Job Title'])
	return {
		personKey: personKey(String(payload['Work Email'])),
		firstName: text(payload['First Name']),
		lastName: text(payload['Last Name']),
		fullName: text(payload['Full Name']),
		title,
		seniority: seniorityOf(enrichment.seniority, title),
		functions: lowerList([enrichment.department]),
		emailStatus: null,
		companyRef: normaliseDomain(payload['Company Domain']),
	}
}
