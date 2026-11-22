import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FIXTURES_DIR, generateFixtures, serialize, type Manifest } from './generate-fixtures.ts'

type Row = Record<string, unknown>

const generated = generateFixtures()
const read = <T>(path: string) => JSON.parse(readFileSync(`${FIXTURES_DIR}/${path}`, 'utf8')) as T

const manifest = read<Manifest>('manifest.json')
const apolloOrgs = read<Row[]>('apollo/organizations.json')
const apolloPeople = read<Row[]>('apollo/people.json')
const factsetEntities = read<Row[]>('factset/entity-references.json')
const factsetFundamentals = read<{ data: Row[] }>('factset/fundamentals.json').data
const factsetPeople = read<Row[]>('factset/people.json')
const clayCompanies = read<Row[]>('clay/companies.json')
const clayPeople = read<Row[]>('clay/people.json')
const history = read<{
	optOuts: { email: string }[]
	pilotCampaign: { daysAgo: number; cards: { email: string }[] }
	historicalCampaign: { daysAgo: number; cards: { email: string; variant: 'A' | 'B' }[] }
	outcomes: { dayOffset?: number }[]
}>('history.json')

const malformed = (kind: 'company' | 'contact') => manifest.malformed.filter((record) => record.kind === kind).length

const companyIds: Record<string, Set<string>> = {
	apollo: new Set(apolloOrgs.map((org) => String(org.id))),
	factset: new Set(factsetEntities.map((entity) => String(entity.fsym_id))),
	clay: new Set(clayCompanies.map((row) => String(row.Domain).trim().toLowerCase())),
}

const normaliseEmail = (email: string) => email.trim().toLowerCase()

describe('fixture generator', () => {
	it('matches the committed fixtures byte for byte', () => {
		for (const [path, value] of Object.entries(generated)) {
			expect(readFileSync(`${FIXTURES_DIR}/${path}`, 'utf8'), path).toBe(serialize(value))
		}
	})

	it('produces the same bytes on every run', () => {
		const again = generateFixtures()
		for (const [path, value] of Object.entries(generated)) expect(serialize(again[path]), path).toBe(serialize(value))
	})
})

describe('manifest agrees with the provider files', () => {
	it('has 300 company records across the three providers, malformed ones excluded', () => {
		const total = apolloOrgs.length + factsetEntities.length + clayCompanies.length - malformed('company')
		expect(total).toBe(300)
		expect(manifest.counts.companyRecords).toBe(300)
		expect(manifest.counts.uniqueCompanies).toBe(282)
	})

	it('has 600 contact records, malformed ones excluded', () => {
		const total = apolloPeople.length + factsetPeople.length + clayPeople.length - malformed('contact')
		expect(total).toBe(600)
		expect(manifest.counts.contactRecords).toBe(600)
	})

	it('lists 18 duplicate companies, each found in two different providers', () => {
		expect(manifest.duplicates).toHaveLength(18)
		for (const duplicate of manifest.duplicates) {
			expect(new Set(duplicate.records.map((record) => record.provider)).size).toBe(2)
			for (const record of duplicate.records) expect(companyIds[record.provider]?.has(record.externalId)).toBe(true)
		}
	})

	it('lists 7 headcount conflicts among the duplicates, each differing by more than 10%', () => {
		const duplicateKeys = new Set(manifest.duplicates.map((duplicate) => duplicate.companyKey))
		expect(manifest.headcountConflicts).toHaveLength(7)
		for (const conflict of manifest.headcountConflicts) {
			expect(duplicateKeys.has(conflict.companyKey)).toBe(true)
			const [a, b] = conflict.values.map((value) => value.headcount)
			expect(Math.abs(a! - b!) / Math.max(a!, b!)).toBeGreaterThan(0.1)
		}
	})

	it('lists 2 address conflicts, one in the top 50: a provider still has an old street for the office', () => {
		const duplicateKeys = new Set(manifest.duplicates.map((duplicate) => duplicate.companyKey))
		expect(manifest.counts.addressConflicts).toBe(2)
		expect(manifest.addressConflicts.map((conflict) => conflict.inTop50)).toEqual([true, false])
		for (const conflict of manifest.addressConflicts) {
			expect(duplicateKeys.has(conflict.companyKey)).toBe(true)
			expect(new Set(conflict.values.map((value) => value.line1)).size).toBe(2)
		}
	})

	it('lists 2 near-duplicates that share a name but not a country or domain', () => {
		expect(manifest.nearDuplicates).toHaveLength(2)
		for (const [a, b] of manifest.nearDuplicates.map((pair) => pair.companies)) {
			expect(a!.country).not.toBe(b!.country)
			expect(a!.domain).not.toBe(b!.domain)
		}
	})

	it('lists 12 suppressed people: 7 opt-outs and 5 mailed in the pilot 45 days ago', () => {
		expect(manifest.suppressed).toHaveLength(12)
		const optOuts = manifest.suppressed.filter((person) => person.reason === 'opt_out')
		const pilot = manifest.suppressed.filter((person) => person.reason === 'mailed_90d')
		expect(optOuts).toHaveLength(7)
		expect(pilot).toHaveLength(5)
		expect(history.optOuts.map((optOut) => normaliseEmail(optOut.email)).sort()).toEqual(
			optOuts.map((person) => person.personKey).sort(),
		)
		expect(history.pilotCampaign.daysAgo).toBe(45)
		expect(history.pilotCampaign.cards.map((card) => normaliseEmail(card.email)).sort()).toEqual(
			pilot.map((person) => person.personKey).sort(),
		)
	})

	it('lists 5 invalid addresses, each failing for a different reason', () => {
		expect(manifest.invalidAddresses).toHaveLength(5)
		expect(new Set(manifest.invalidAddresses.map((address) => address.reason)).size).toBe(5)
	})

	it('puts 8 suppressed and 3 invalid addresses in the top 50 without overlap, leaving 39 eligible', () => {
		const { companies } = manifest.top50
		expect(companies).toHaveLength(50)
		const blocked = companies.filter((company) => company.expected !== 'eligible')
		expect(companies.filter((company) => company.expected.startsWith('suppressed:'))).toHaveLength(8)
		expect(companies.filter((company) => company.expected.startsWith('invalid_address:'))).toHaveLength(3)
		expect(blocked).toHaveLength(11)
		expect(manifest.top50.expectedEligible).toBe(39)

		const top50Suppressed = manifest.suppressed.filter((person) => person.inTop50)
		expect(top50Suppressed).toHaveLength(8)
		expect(top50Suppressed.filter((person) => person.viaDuplicateContact)).toHaveLength(1)
		expect(manifest.invalidAddresses.filter((address) => address.inTop50)).toHaveLength(3)
	})

	it('scores exactly 50 companies at 90 or more, so the top 50 does not depend on tie-breaks', () => {
		const scores = manifest.top50.companies.map((company) => company.expectedScore)
		expect(scores.every((score) => score >= 90)).toBe(true)
		expect(manifest.top50.nextBestScore).toBeLessThanOrEqual(80)
	})

	it('has a historical campaign of 40 cards split A/B 120 days ago, with outcomes after day 30', () => {
		expect(history.historicalCampaign.daysAgo).toBe(120)
		expect(history.historicalCampaign.cards).toHaveLength(40)
		expect(history.historicalCampaign.cards.filter((card) => card.variant === 'A')).toHaveLength(20)
		expect(history.outcomes.some((outcome) => (outcome.dayOffset ?? 0) > 30)).toBe(true)
	})

	it('only uses FactSet fundamentals for known entities', () => {
		for (const row of factsetFundamentals) expect(companyIds.factset!.has(String(row.fsym_id))).toBe(true)
	})
})
