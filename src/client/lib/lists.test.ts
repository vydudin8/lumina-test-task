import { describe, expect, it } from 'vitest'
import { dayStart, nextSort, outcomeTime } from './lists.ts'

describe('nextSort', () => {
	it('sorts a new column its natural way, reverses it, then clears back to the default', () => {
		let current = { sort: 'name', dir: 'asc' }
		current = nextSort('headcount', 'desc', current)
		expect(current).toEqual({ sort: 'headcount', dir: 'desc' })
		current = nextSort('headcount', 'desc', current)
		expect(current).toEqual({ sort: 'headcount', dir: 'asc' })
		expect(nextSort('headcount', 'desc', current)).toEqual({ sort: '', dir: '' })
	})

	it('treats the default sort as already clicked once', () => {
		expect(nextSort('name', 'asc', { sort: 'name', dir: 'asc' })).toEqual({ sort: 'name', dir: 'desc' })
		expect(nextSort('name', 'asc', { sort: 'name', dir: 'desc' })).toEqual({ sort: '', dir: '' })
	})

	it('starts over on another column', () => {
		expect(nextSort('revenue', 'desc', { sort: 'headcount', dir: 'asc' })).toEqual({ sort: 'revenue', dir: 'desc' })
	})
})

describe('dayStart', () => {
	it('is local midnight of the day, optionally days later across a month end', () => {
		expect(dayStart('2026-11-24')).toBe(new Date(2026, 10, 24).toISOString())
		expect(dayStart('2026-11-30', 1)).toBe(new Date(2026, 11, 1).toISOString())
	})

	it('rejects anything that is not a real day', () => {
		expect(dayStart('')).toBeNull()
		expect(dayStart('yesterday')).toBeNull()
		expect(dayStart('2026-02-30')).toBeNull()
	})
})

describe('outcomeTime', () => {
	const mailedAt = new Date(2026, 10, 24, 21, 41).toISOString()
	const at = (hour: number, minute = 0) => new Date(2026, 10, 25, hour, minute)

	it('is local noon of a day between the mailing and today', () => {
		expect(outcomeTime('2026-11-20', '2026-11-10T09:00:00Z', at(15))).toBe(new Date(2026, 10, 20, 12).toISOString())
	})

	it('is never before the mailing, so the outcome counts for the card', () => {
		expect(outcomeTime('2026-11-24', mailedAt, at(15))).toBe(mailedAt)
	})

	it('is never after now, so today works before noon too', () => {
		expect(outcomeTime('2026-11-25', mailedAt, at(1, 21))).toBe(at(1, 21).toISOString())
	})
})
