import { describe, expect, it } from 'vitest'
import { contentHash, creditsFor, parseApollo, parseClay, parseFactset } from './core.ts'

describe('contentHash', () => {
	it('ignores key order, so a re-pull of the same record is recognised', () => {
		expect(contentHash({ a: 1, b: { c: [1, 2], d: null } })).toBe(contentHash({ b: { d: null, c: [1, 2] }, a: 1 }))
	})

	it('changes when any value changes', () => {
		expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }))
	})
})

describe('parseApollo', () => {
	it('keeps valid organizations and people, keyed by Apollo id', () => {
		const { records, errors } = parseApollo({
			organizations: [{ id: 'o1', name: 'Hartley Plant Hire Ltd' }],
			people: [{ id: 'p1', email: 'a.b@hartley.co.uk', organization_id: 'o1' }],
		})
		expect(records.map((record) => [record.kind, record.externalId])).toEqual([
			['company', 'o1'],
			['contact', 'p1'],
		])
		expect(errors).toEqual([])
	})

	it('rejects an organization without a name, saying what is missing', () => {
		const { records, errors } = parseApollo({ organizations: [{ id: 'o2', name: null }], people: [] })
		expect(records).toEqual([])
		expect(errors).toEqual([expect.objectContaining({ kind: 'company', externalId: 'o2', problem: 'missing name' })])
	})
})

describe('parseFactset', () => {
	const entity = { fsym_id: 'AAA111-E', entity_proper_name: 'Calder Civils Limited' }

	it('attaches each entity its fundamentals and keys people by person_id', () => {
		const { records, errors } = parseFactset({
			entities: [entity],
			fundamentals: [
				{ fsym_id: 'AAA111-E', metric: 'FF_SALES', fiscal_end_date: '2026-03-31', currency: 'GBP', value: 45.5 },
				{ fsym_id: 'AAA111-E', metric: 'FF_EMP', fiscal_end_date: '2026-03-31', currency: null, value: 210 },
			],
			people: [{ person_id: 'P1-P', fsym_id: 'AAA111-E', email: 'x.y@calder.co.uk' }],
		})
		expect(errors).toEqual([])
		const company = records.find((record) => record.kind === 'company')
		expect(company?.payload).toMatchObject({
			entity_reference: entity,
			fundamentals: [{ metric: 'FF_EMP' }, { metric: 'FF_SALES' }],
		})
		expect(records.find((record) => record.kind === 'contact')?.externalId).toBe('P1-P')
	})

	it('rejects a fundamentals row whose value is not a number', () => {
		const { errors } = parseFactset({
			entities: [entity],
			fundamentals: [{ fsym_id: 'AAA111-E', metric: 'FF_EMP', fiscal_end_date: '2023-03-31', value: 'N/A' }],
			people: [],
		})
		expect(errors).toEqual([
			expect.objectContaining({ kind: 'fundamental', externalId: 'AAA111-E', problem: 'value is not a number' }),
		])
	})
})

describe('parseClay', () => {
	it('keys company rows by domain and people by email, lower-cased', () => {
		const { records } = parseClay({
			companies: [{ 'Company Name': 'Kestrel Plant', Domain: ' WWW.Kestrel.co.uk ' }],
			people: [{ 'Work Email': 'Sam.Lee@Kestrel.co.uk', 'Company Domain': 'kestrel.co.uk' }],
		})
		expect(records.map((record) => record.externalId)).toEqual(['www.kestrel.co.uk', 'sam.lee@kestrel.co.uk'])
	})

	it('rejects a person row without a usable work email', () => {
		const { errors } = parseClay({
			companies: [],
			people: [{ 'Work Email': 'not found', 'Company Domain': 'kestrel.co.uk' }],
		})
		expect(errors).toEqual([expect.objectContaining({ kind: 'contact', problem: 'invalid Work Email' })])
	})
})

describe('creditsFor', () => {
	it('prices records from the cost table in exact decimals', () => {
		expect(creditsFor('factset', { company: 3, contact: 3 }).toString()).toBe('1.05')
		expect(creditsFor('apollo', { company: 131, contact: 301 }).toString()).toBe('432')
	})
})
