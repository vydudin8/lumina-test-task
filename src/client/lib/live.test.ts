import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COALESCE_MS, createInvalidator, JITTER_MS, keysFor } from './live.ts'

describe('keysFor', () => {
	it("sends a campaign notice to that campaign, the campaign list and that campaign's results", () => {
		expect(keysFor('campaign:7')).toEqual([['campaign', 7], ['campaigns'], ['results', 7]])
	})

	it("reaches the campaign's cards, whose queries sit under the campaign's key", async () => {
		const queryClient = new QueryClient()
		queryClient.setQueryData(['campaign', 7, 'cards', 'show=review'], {})
		queryClient.setQueryData(['campaign', 8, 'cards', ''], {})
		for (const key of keysFor('campaign:7')) await queryClient.invalidateQueries({ queryKey: key, refetchType: 'none' })
		expect(queryClient.getQueryState(['campaign', 7, 'cards', 'show=review'])?.isInvalidated).toBe(true)
		expect(queryClient.getQueryState(['campaign', 8, 'cards', ''])?.isInvalidated).toBe(false)
	})

	it("sends a results notice to that campaign's results only", () => {
		expect(keysFor('results:7')).toEqual([['results', 7]])
	})

	it("sends a run notice to the providers page, the run lists, that run's page and its records", () => {
		expect(keysFor('run:12')).toEqual([['providers'], ['ingestion-runs'], ['ingestion-run', '12'], ['raw-records']])
	})

	it('refetches everything after a resync, and for a notice it does not know', () => {
		const everything = [
			['campaign'],
			['campaigns'],
			['results'],
			['providers'],
			['ingestion-runs'],
			['ingestion-run'],
			['raw-records'],
		]
		expect(keysFor('resync')).toEqual(everything)
		expect(keysFor('something-new')).toEqual(everything)
	})
})

describe('createInvalidator', () => {
	beforeEach(() => void vi.useFakeTimers())
	afterEach(() => void vi.useRealTimers())

	it('invalidates a key once per window however often it is pushed', () => {
		const invalidate = vi.fn()
		const invalidator = createInvalidator(invalidate, 300, () => 0)
		invalidator.push(keysFor('campaign:7'))
		vi.advanceTimersByTime(100)
		invalidator.push(keysFor('campaign:7'))
		invalidator.push(keysFor('results:7'))
		expect(invalidate).not.toHaveBeenCalled()

		vi.advanceTimersByTime(200)
		expect(invalidate.mock.calls).toEqual([[['campaign', 7]], [['campaigns']], [['results', 7]]])
	})

	it('starts a new window for the next burst', () => {
		const invalidate = vi.fn()
		const invalidator = createInvalidator(invalidate, 300, () => 0)
		invalidator.push(keysFor('results:7'))
		vi.advanceTimersByTime(300)
		invalidator.push(keysFor('results:7'))
		vi.advanceTimersByTime(300)
		expect(invalidate).toHaveBeenCalledTimes(2)
	})

	it("adds the tab's own jitter to the window, so many open tabs do not refetch together", () => {
		const invalidate = vi.fn()
		const invalidator = createInvalidator(invalidate, 1000, () => 400)
		invalidator.push(keysFor('results:7'))
		vi.advanceTimersByTime(1399)
		expect(invalidate).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(invalidate).toHaveBeenCalledTimes(1)
	})

	it('keeps the default window and jitter inside the five seconds a status may take to show', () => {
		expect(COALESCE_MS + JITTER_MS).toBeLessThan(5000)
		const random = vi.spyOn(Math, 'random').mockReturnValue(0.999)
		const invalidate = vi.fn()
		createInvalidator(invalidate).push(keysFor('results:7'))
		vi.advanceTimersByTime(COALESCE_MS + JITTER_MS)
		expect(invalidate).toHaveBeenCalledTimes(1)
		random.mockRestore()
	})

	it('drops what is pending when stopped', () => {
		const invalidate = vi.fn()
		const invalidator = createInvalidator(invalidate, 300, () => 0)
		invalidator.push(keysFor('results:7'))
		invalidator.stop()
		vi.advanceTimersByTime(1000)
		expect(invalidate).not.toHaveBeenCalled()
	})
})
