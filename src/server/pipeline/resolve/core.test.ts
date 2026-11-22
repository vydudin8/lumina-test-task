import { describe, expect, it } from 'vitest'
import {
	cluster,
	normaliseContact,
	normaliseCountry,
	normaliseDomain,
	normaliseName,
	normaliseSource,
	resolveFields,
	seniorityFromTitle,
	type FxRate,
	type SourceCompany,
} from './core.ts'

const fx: FxRate[] = [
	{ id: 1, currency: 'GBP', rate: '1', asOf: '2026-10-30' },
	{ id: 2, currency: 'USD', rate: '0.79', asOf: '2026-10-30' },
	{ id: 3, currency: 'EUR', rate: '0.85', asOf: '2026-10-30' },
]
const now = new Date('2026-11-20T12:00:00Z')

describe('normalisation', () => {
	it.each([
		['https://www.Hartley.co.uk/', 'hartley.co.uk'],
		['www.hartley.co.uk', 'hartley.co.uk'],
		['http://hartley.co.uk/about', 'hartley.co.uk'],
		['HARTLEY.CO.UK', 'hartley.co.uk'],
		['', null],
		[null, null],
	])('domain %s -> %s', (input, expected) => {
		expect(normaliseDomain(input)).toBe(expected)
	})

	it.each([
		['Hartley Plant Hire Ltd', 'hartley plant hire'],
		['HARTLEY PLANT HIRE LIMITED', 'hartley plant hire'],
		['Hartley Plant Hire Ltd.', 'hartley plant hire'],
		['Calder Civil Engineering B.V.', 'calder civil engineering'],
		['Kestrel Tool & Plant Hire GmbH', 'kestrel tool and plant hire'],
	])('name %s -> %s', (input, expected) => {
		expect(normaliseName(input)).toBe(expected)
	})

	it.each([
		['United Kingdom', 'GB'],
		['UK', 'GB'],
		['GB', 'GB'],
		['Ireland', 'IE'],
		['Netherlands', 'NL'],
		['Atlantis', null],
	])('country %s -> %s', (input, expected) => {
		expect(normaliseCountry(input)).toBe(expected)
	})
})

describe('normaliseSource', () => {
	it('reads an Apollo organization and converts USD revenue to GBP with the rate used', () => {
		const fields = normaliseSource(
			'apollo',
			{
				name: 'Hartley Plant Hire Ltd',
				primary_domain: 'hartley.co.uk',
				country: 'United Kingdom',
				industry: 'equipment rental services',
				estimated_num_employees: 240,
				annual_revenue: 20000000,
				street_address: 'Unit 4, Mill Lane',
				city: 'Leeds',
				state: 'West Yorkshire',
				postal_code: 'LS12 6AB',
				technology_names: ['Microsoft Office 365', 'Geotab'],
				total_funding: null,
			},
			fx,
		)
		expect(fields).toMatchObject({
			name: 'Hartley Plant Hire Ltd',
			domain: 'hartley.co.uk',
			country: 'GB',
			industry: 'Plant hire',
			headcount: 240,
			revenue: {
				amount: '20000000',
				currency: 'USD',
				gbp: '15800000',
				fxRateId: 2,
				rate: '0.79',
				rateAsOf: '2026-10-30',
			},
			address: { line1: 'Unit 4, Mill Lane', city: 'Leeds', postcode: 'LS12 6AB', country: 'GB' },
			signals: ['fleet_telematics'],
		})
	})

	it('reads FactSet fundamentals: latest fiscal year, sales in millions, dates kept as "as of"', () => {
		const fields = normaliseSource(
			'factset',
			{
				entity_reference: {
					entity_proper_name: 'Calder Civils Limited',
					website: 'www.calder.ie',
					headquarters_country: 'IE',
				},
				fundamentals: [
					{ metric: 'FF_EMP', fiscal_end_date: '2025-12-31', value: 410 },
					{ metric: 'FF_EMP', fiscal_end_date: '2024-12-31', value: 380 },
					{ metric: 'FF_SALES', fiscal_end_date: '2025-12-31', currency: 'EUR', value: 52.5 },
				],
			},
			fx,
		)
		expect(fields).toMatchObject({
			domain: 'calder.ie',
			country: 'IE',
			industry: null,
			headcount: 410,
			revenue: { amount: '52500000', currency: 'EUR', gbp: '44625000' },
			asOf: { headcount: '2025-12-31', revenue: '2025-12-31' },
		})
	})

	it('keeps an unmapped industry label visible instead of guessing', () => {
		const fields = normaliseSource(
			'clay',
			{ 'Company Name': 'X', Domain: 'x.co.uk', Industry: 'Space Tourism', 'Enriched At': '2026-10-01T09:00:00Z' },
			fx,
		)
		expect(fields).toMatchObject({ industry: null, industryLabel: 'Space Tourism', asOf: { industry: '2026-10-01' } })
	})
})

function source(id: number, overrides: Partial<SourceCompany>): SourceCompany {
	return {
		id,
		provider: 'apollo',
		externalId: `x${id}`,
		rawRecordId: id * 10,
		fetchedAt: '2026-11-20T10:00:00.000Z',
		name: 'Hartley Plant Hire Ltd',
		normalisedName: 'hartley plant hire',
		domain: 'hartley.co.uk',
		country: 'GB',
		industry: 'Plant hire',
		industryLabel: 'equipment rental services',
		headcount: 200,
		revenue: null,
		address: null,
		signals: [],
		asOf: {},
		...overrides,
	}
}

describe('cluster', () => {
	it('merges equal domains, and equal name + country when one domain is missing', () => {
		const { groups } = cluster(
			[source(1, {}), source(2, { provider: 'factset' }), source(3, { provider: 'clay', domain: null })],
			[],
		)
		expect(groups).toEqual([[1, 2, 3]])
	})

	it('keeps the same name apart when the country or the domain differs, and lists them as possible duplicates', () => {
		const { groups, possibleDuplicates } = cluster(
			[source(1, {}), source(2, { country: 'IE', domain: 'hartley.ie' }), source(3, { domain: 'hartley-plant.co.uk' })],
			[],
		)
		expect(groups).toEqual([[1], [2], [3]])
		expect(possibleDuplicates.map(({ a, b }) => [a, b])).toEqual([
			[1, 2],
			[1, 3],
			[2, 3],
		])
	})

	it('never chains two contradicting domains together through a record without a domain', () => {
		const { groups } = cluster([source(1, {}), source(2, { domain: null }), source(3, { domain: 'other.co.uk' })], [])
		expect(groups).toEqual([[1, 2], [3]])
	})

	it('applies a manual merge and a manual split', () => {
		const merged = cluster(
			[source(1, {}), source(2, { country: 'IE', domain: 'hartley.ie' })],
			[{ a: 1, b: 2, decision: 'merge' }],
		)
		expect(merged.groups).toEqual([[1, 2]])
		const split = cluster([source(1, {}), source(2, { provider: 'factset' })], [{ a: 1, b: 2, decision: 'split' }])
		expect(split.groups).toEqual([[1], [2]])
		expect(split.possibleDuplicates).toEqual([expect.objectContaining({ a: 1, b: 2, reason: 'split by a person' })])
	})
})

describe('resolveFields', () => {
	const apollo = source(1, { provider: 'apollo', headcount: 300 })
	const factset = source(2, { provider: 'factset', headcount: 250, asOf: { headcount: '2024-03-31' } })
	const clay = source(3, { provider: 'clay', headcount: 255 })

	it('takes headcount from the highest-precedence source and flags a >10% disagreement', () => {
		const resolved = resolveFields([apollo, factset, clay], [], now)
		expect(resolved.headcount).toMatchObject({
			value: 250,
			provider: 'factset',
			sourceId: 2,
			rawRecordId: 20,
			conflict: true,
		})
		expect(resolved.headcount.candidates.map((candidate) => candidate.provider)).toEqual(['factset', 'apollo', 'clay'])
	})

	it('does not flag a disagreement of 10% or less', () => {
		const resolved = resolveFields([factset, clay], [], now)
		expect(resolved.headcount.conflict).toBe(false)
	})

	it('marks a value stale when its "as of" date is older than 18 months', () => {
		expect(resolveFields([factset], [], now).headcount).toMatchObject({ stale: true, asOf: '2024-03-31' })
		expect(resolveFields([apollo], [], now).headcount).toMatchObject({ stale: false, asOf: null })
	})

	it('uses an override when its chosen source belongs to the company', () => {
		const override = {
			field: 'headcount' as const,
			chosenSourceId: 1,
			createdBy: 'usr_rep_tom',
			reason: 'Phoned them',
			at: '2026-11-19T10:00:00.000Z',
		}
		const resolved = resolveFields([apollo, factset], [override], now)
		expect(resolved.headcount).toMatchObject({ value: 300, provider: 'apollo', override: { reason: 'Phoned them' } })
	})

	it('flags industry and country when providers disagree after normalisation', () => {
		const resolved = resolveFields(
			[apollo, source(4, { provider: 'clay', industry: 'Construction', country: 'IE' })],
			[],
			now,
		)
		expect(resolved.industry.conflict).toBe(true)
		expect(resolved.country.conflict).toBe(true)
	})

	it('flags an address only when the street, town, postcode or country really differ', () => {
		const office = { line1: 'Unit 4, Mill Lane', city: 'Leeds', region: null, postcode: 'LS12 6AB', country: 'GB' }
		const sameOffice = { ...office, line1: 'UNIT 4 MILL LANE', postcode: 'ls126ab' }
		const oldOffice = { ...office, line1: '12 Station Road' }
		const withAddress = (id: number, provider: 'apollo' | 'factset' | 'clay', address: typeof office) =>
			source(id, { provider, address })

		const same = resolveFields([withAddress(1, 'apollo', office), withAddress(3, 'clay', sameOffice)], [], now)
		expect(same.address.conflict).toBe(false)

		const moved = resolveFields([withAddress(1, 'apollo', office), withAddress(3, 'clay', oldOffice)], [], now)
		expect(moved.address).toMatchObject({ value: office, provider: 'apollo', conflict: true })
		expect(moved.address.candidates.map((candidate) => candidate.value.line1)).toEqual([
			'Unit 4, Mill Lane',
			'12 Station Road',
		])
	})

	it('unions signals and remembers which provider reported each', () => {
		const resolved = resolveFields(
			[source(1, { signals: ['funded'] }), source(2, { provider: 'clay', signals: ['net_zero_target'] })],
			[],
			now,
		)
		expect(resolved.signals.value).toEqual(['funded', 'net_zero_target'])
	})

	it('leaves a field unknown when no source has it', () => {
		expect(resolveFields([source(1, { revenue: null })], [], now).revenue).toMatchObject({
			value: null,
			provider: null,
		})
	})
})

describe('normaliseContact', () => {
	it('reads an Apollo person: normalised email as person key, seniority and functions as given', () => {
		expect(
			normaliseContact('apollo', {
				first_name: 'Ben',
				last_name: 'Khan',
				name: 'Ben Khan',
				title: 'Operations Director',
				seniority: 'director',
				functions: ['operations'],
				departments: ['master_operations'],
				email: 'Ben.Khan@Ottery.co.uk ',
				email_status: 'verified',
				organization_id: 'org1',
			}),
		).toEqual({
			personKey: 'ben.khan@ottery.co.uk',
			firstName: 'Ben',
			lastName: 'Khan',
			fullName: 'Ben Khan',
			title: 'Operations Director',
			seniority: 'director',
			functions: ['operations', 'master_operations'],
			emailStatus: 'verified',
			companyRef: 'org1',
		})
	})

	it('derives FactSet seniority from the title and links by fsym_id', () => {
		expect(
			normaliseContact('factset', {
				name: 'Aoife Byrne',
				title: 'Chief Operating Officer',
				job_function1: 'Operations',
				email: 'a@b.ie',
				fsym_id: 'F1-E',
			}),
		).toMatchObject({
			firstName: 'Aoife',
			lastName: 'Byrne',
			seniority: 'c_suite',
			functions: ['operations'],
			companyRef: 'F1-E',
		})
	})

	it('links a Clay person to the Clay company by normalised domain', () => {
		expect(
			normaliseContact('clay', {
				'First Name': 'Sam',
				'Last Name': 'Lee',
				'Full Name': 'Sam Lee',
				'Job Title': 'Head of Plant',
				'Work Email': 'sam.lee@kestrel.co.uk',
				'Company Domain': 'https://www.kestrel.co.uk/',
				'Person Enrichment': { seniority: 'Head', department: 'Engineering' },
			}),
		).toMatchObject({ seniority: 'head', functions: ['engineering'], companyRef: 'kestrel.co.uk' })
	})

	it.each([
		['Chief Executive Officer', 'c_suite'],
		['VP Operations', 'vp'],
		['Managing Director', 'director'],
		['Head of Sustainability', 'head'],
		['Fleet Manager', 'manager'],
		['Estimator', 'other'],
	])('seniority from title %s -> %s', (title, expected) => {
		expect(seniorityFromTitle(title)).toBe(expected)
	})
})
