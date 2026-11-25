import { describe, expect, it } from 'vitest'
import { stoppableSleep } from './clock.ts'

describe('stoppableSleep', () => {
	it('ends at once when its loop is stopped, so a shutdown never waits out a long pause', async () => {
		const stop = new AbortController()
		const started = Date.now()
		const pause = stoppableSleep(stop.signal)(60_000)
		stop.abort()
		await pause
		expect(Date.now() - started).toBeLessThan(1000)
		// Already stopped: the next pause does not wait either.
		await stoppableSleep(stop.signal)(60_000)
	})
})
