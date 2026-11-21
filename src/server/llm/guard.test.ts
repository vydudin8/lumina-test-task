import { describe, expect, it } from 'vitest'
import { guardOutput } from './guard.ts'
import type { EvidenceItem } from './types.ts'

const evidence: EvidenceItem[] = [
	{ id: 'e1', label: 'industry', value: 'Quarrying', source: 'Apollo', date: '2026-11-20' },
	{ id: 'e2', label: 'headcount', value: '1,186', source: 'FactSet', date: '2026-03-31' },
	{ id: 'e3', label: 'revenue', value: '£44,945,000', source: 'FactSet', date: '2026-03-31' },
]
const guard = (raw: string) => guardOutput(raw, evidence, { maxChars: 200 })
const output = (text: string, cites: string[]) => JSON.stringify({ text, cites })
const codes = (raw: string) => {
	const result = guard(raw)
	return result.ok ? [] : result.rejections.map((rejection) => rejection.code)
}

describe('guardOutput', () => {
	it('accepts text whose numbers all appear in the cited evidence', () => {
		expect(guard(output('A quarrying firm with 1186 people and £44,945,000 in sales.', ['e1', 'e2', 'e3']))).toEqual({
			ok: true,
			text: 'A quarrying firm with 1186 people and £44,945,000 in sales.',
			cites: ['e1', 'e2', 'e3'],
		})
	})

	it('rejects output that is not JSON or not {text, cites}', () => {
		expect(codes('Sure! Here is the line')).toEqual(['invalid_json'])
		expect(codes(JSON.stringify({ line: 'x' }))).toEqual(['invalid_json'])
	})

	it('rejects empty and over-long text', () => {
		expect(codes(output('  ', ['e1']))).toEqual(['empty_text'])
		expect(codes(output('x'.repeat(201), ['e1']))).toEqual(['too_long'])
	})

	it('rejects a citation that is not in the evidence, and output that cites nothing', () => {
		expect(guard(output('A quarrying firm.', ['e1', 'e9']))).toMatchObject({
			ok: false,
			rejections: [{ code: 'unknown_citation', detail: 'cites e9, which is not in the evidence' }],
		})
		expect(codes(output('A quarrying firm.', []))).toEqual(['no_citation'])
	})

	it('rejects a number that is not in the cited evidence, even if another item has it', () => {
		expect(guard(output('Runs 120 sites across the UK.', ['e1']))).toMatchObject({
			ok: false,
			rejections: [{ code: 'uncited_number', detail: "number '120' is not in the evidence" }],
		})
		expect(codes(output('About 1,186 staff.', ['e1']))).toEqual(['uncited_number'])
	})

	it.each([
		['twelve', 'Running twelve quarries across three counties.'],
		['hundreds', 'Hundreds of machines and a dozen depots.'],
		['120', 'Your １２０ sites.'],
	])('rejects the number %s written in words or other digits', (number, text) => {
		const result = guard(output(text, ['e1']))
		expect(result).toMatchObject({
			ok: false,
			rejections: [{ code: 'uncited_number', detail: expect.stringContaining(`'${number}'`) as string }],
		})
	})

	it('rejects a cited number with a different currency or unit sign', () => {
		expect(guard(output('A fleet worth $44,945,000.', ['e3']))).toMatchObject({
			ok: false,
			rejections: [{ code: 'uncited_number', detail: "number '$44945000' is not in the evidence" }],
		})
		expect(codes(output('About 1,186% growth.', ['e2']))).toEqual(['uncited_number'])
		expect(
			codes(output('Sales of £44,945,000 and 1186 staff, one of the largest in quarrying.', ['e1', 'e2', 'e3'])),
		).toEqual([])
	})

	it.each([
		['an email address', 'Write to jo.bloggs@ashdown.co.uk today.'],
		['a phone number', 'Call +44 113 496 0123 now.'],
		['a URL', 'See www.ashdown.co.uk for more.'],
	])('rejects %s', (_label, text) => {
		expect(codes(output(text, ['e1']))).toContain('contains_contact_data')
	})

	it('reports every problem at once', () => {
		expect(codes(output('Call +44 113 496 0123 about 120 sites.', ['e7']))).toEqual([
			'unknown_citation',
			'uncited_number',
			'contains_contact_data',
		])
	})
})
