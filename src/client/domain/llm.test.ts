import { describe, expect, it } from 'vitest'
import { draftText, madeUpNumbers, markNumbers, placeCitations, rejectionSummary } from './llm.ts'

describe('markNumbers', () => {
	it('marks only the rejected numbers, matched the way the guard reads them', () => {
		expect(
			markNumbers('Has 1,120 staff, £44,945,000 revenue and Hundreds of sites across 120 depots.', [
				'120',
				'£44945000',
				'hundreds',
			]),
		).toEqual([
			{ text: 'Has 1,120 staff, ', marked: false },
			{ text: '£44,945,000', marked: true },
			{ text: ' revenue and ', marked: false },
			{ text: 'Hundreds', marked: true },
			{ text: ' of sites across ', marked: false },
			{ text: '120', marked: true },
			{ text: ' depots.', marked: false },
		])
	})

	it('keeps the comma after a number out of the mark', () => {
		expect(markNumbers('Revenue of £44,945,000, across sites.', ['£44945000'])).toEqual([
			{ text: 'Revenue of ', marked: false },
			{ text: '£44,945,000', marked: true },
			{ text: ', across sites.', marked: false },
		])
	})

	it('leaves the text whole when nothing is rejected', () => {
		expect(markNumbers('Has 842 staff.', [])).toEqual([{ text: 'Has 842 staff.', marked: false }])
	})
})

describe('draftText', () => {
	it('reads the text out of the model answer, or shows an unreadable answer as it came', () => {
		expect(draftText('{"text":" Runs 120 sites. ","cites":["e1"]}')).toBe('Runs 120 sites.')
		expect(draftText('Sure! Here is the line')).toBe('Sure! Here is the line')
		expect(draftText(null)).toBeNull()
	})
})

describe('rejectionSummary', () => {
	it('names each problem once, in plain words', () => {
		expect(
			rejectionSummary([
				{ code: 'uncited_number', detail: "numbers '120', '7' are not in the evidence", values: ['120', '7'] },
				{ code: 'too_long', detail: 'the text is 400 characters, the limit is 320' },
			]),
		).toBe('made-up numbers, too long')
		expect(rejectionSummary([{ code: 'uncited_number', detail: "number '120' is not in the evidence" }])).toBe(
			'made-up number',
		)
	})
})

describe('madeUpNumbers', () => {
	it('reads the values, or the quoted numbers of a row saved before the guard listed values', () => {
		expect(madeUpNumbers({ code: 'uncited_number', detail: "number '120' is not…", values: ['120'] })).toEqual(['120'])
		expect(
			madeUpNumbers({ code: 'uncited_number', detail: "numbers '120', 'hundreds' are not in the evidence" }),
		).toEqual(['120', 'hundreds'])
		expect(madeUpNumbers({ code: 'unknown_citation', detail: 'cites e9, which is not in the evidence' })).toEqual([])
	})
})

describe('placeCitations', () => {
	const evidence = [
		{ id: 'e1', value: 'Mercia Construction DAC' },
		{ id: 'e2', value: 'Construction' },
		{ id: 'e4', value: '2,330' },
		{ id: 'e5', value: '£35,031,000' },
		{ id: 'e6', value: 'Uses fleet telematics; Has raised funding' },
		{ id: 'e8', value: 'none' },
	]

	it('marks each item after the words that quote it, a longer value first, and the rest at the end', () => {
		expect(
			placeCitations(
				'Mercia Construction DAC works in construction, has 2,330 staff (not 12,330), revenue of £35,031,000 and has raised funding.',
				evidence,
			),
		).toEqual([
			{ text: 'Mercia Construction DAC', cites: ['e1'] },
			{ text: ' works in construction', cites: ['e2'] },
			{ text: ', has 2,330', cites: ['e4'] },
			{ text: ' staff (not 12,330), revenue of £35,031,000', cites: ['e5'] },
			{ text: ' and has raised funding', cites: ['e6'] },
			{ text: '.', cites: ['e8'] },
		])
	})

	it('keeps the text whole when nothing is cited', () => {
		expect(placeCitations('No facts here.', [])).toEqual([{ text: 'No facts here.', cites: [] }])
	})
})
