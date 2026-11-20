import { describe, expect, it } from 'vitest'
import { HttpError, isTransientError, parseRetryAfter, retry, type RetryOptions } from './retry.ts'

function recorder(overrides: RetryOptions = {}) {
	const sleeps: number[] = []
	const retries: { attempt: number; delayMs: number }[] = []
	const options: RetryOptions = {
		rng: () => 0.5,
		sleep: (ms) => {
			sleeps.push(ms)
			return Promise.resolve()
		},
		onRetry: ({ attempt, delayMs }) => retries.push({ attempt, delayMs }),
		...overrides,
	}
	return { sleeps, retries, options }
}

function failTimes<T>(times: number, error: () => Error, value: T) {
	const attempts: number[] = []
	const fn = (attempt: number) => {
		attempts.push(attempt)
		return attempts.length <= times ? Promise.reject(error()) : Promise.resolve(value)
	}
	return { attempts, fn }
}

describe('retry', () => {
	it('returns the first successful result without sleeping', async () => {
		const { sleeps, options } = recorder()
		await expect(retry(() => Promise.resolve('ok'), options)).resolves.toBe('ok')
		expect(sleeps).toEqual([])
	})

	it('retries transient failures and passes the 1-based attempt number', async () => {
		const { options } = recorder()
		const { attempts, fn } = failTimes(2, () => new HttpError(503, 'unavailable'), 'ok')
		await expect(retry(fn, options)).resolves.toBe('ok')
		expect(attempts).toEqual([1, 2, 3])
	})

	it('gives up after maxAttempts and rethrows the last error', async () => {
		const { sleeps, options } = recorder()
		const { attempts, fn } = failTimes(99, () => new HttpError(500, 'boom'), 'never')
		await expect(retry(fn, options)).rejects.toMatchObject({ status: 500 })
		expect(attempts).toHaveLength(6)
		expect(sleeps).toHaveLength(5)
	})

	it('does not retry a non-retryable error', async () => {
		const { sleeps, options } = recorder()
		const { attempts, fn } = failTimes(99, () => new HttpError(422, 'invalid address'), 'never')
		await expect(retry(fn, options)).rejects.toMatchObject({ status: 422 })
		expect(attempts).toEqual([1])
		expect(sleeps).toEqual([])
	})

	it('uses full jitter: delay = rng * min(cap, base * 2^n)', async () => {
		const { sleeps, options } = recorder({ rng: () => 0.5 })
		const { fn } = failTimes(99, () => new HttpError(500, 'boom'), 'never')
		await expect(retry(fn, options)).rejects.toThrow()
		expect(sleeps).toEqual([250, 500, 1000, 2000, 4000])
	})

	it('keeps every delay within [0, capMs)', async () => {
		const { sleeps, options } = recorder({ rng: () => 0.999, baseMs: 500, capMs: 1000, maxAttempts: 8 })
		const { fn } = failTimes(99, () => new HttpError(500, 'boom'), 'never')
		await expect(retry(fn, options)).rejects.toThrow()
		expect(sleeps).toHaveLength(7)
		for (const ms of sleeps) {
			expect(ms).toBeGreaterThanOrEqual(0)
			expect(ms).toBeLessThan(1000)
		}
		expect(sleeps.slice(1)).toEqual(Array(6).fill(999))
	})

	it('honours Retry-After instead of the jittered delay', async () => {
		const { sleeps, options } = recorder()
		const { fn } = failTimes(1, () => new HttpError(429, 'slow down', 2000), 'ok')
		await expect(retry(fn, options)).resolves.toBe('ok')
		expect(sleeps).toEqual([2000])
	})

	it('reports each retry with the failed attempt and the delay', async () => {
		const { retries, options } = recorder()
		const { fn } = failTimes(2, () => new HttpError(500, 'boom'), 'ok')
		await retry(fn, options)
		expect(retries).toEqual([
			{ attempt: 1, delayMs: 250 },
			{ attempt: 2, delayMs: 500 },
		])
	})

	it('accepts a custom isRetryable', async () => {
		const { options } = recorder({ isRetryable: () => false })
		const { attempts, fn } = failTimes(99, () => new HttpError(503, 'unavailable'), 'never')
		await expect(retry(fn, options)).rejects.toThrow()
		expect(attempts).toEqual([1])
	})
})

describe('isTransientError', () => {
	it.each([429, 500, 502, 503, 504])('retries HTTP %i', (status) => {
		expect(isTransientError(new HttpError(status, 'x'))).toBe(true)
	})

	it.each([400, 401, 403, 404, 409, 422])('does not retry HTTP %i', (status) => {
		expect(isTransientError(new HttpError(status, 'x'))).toBe(false)
	})

	it('retries timeouts and network errors', () => {
		expect(isTransientError(new DOMException('timed out', 'TimeoutError'))).toBe(true)
		expect(isTransientError(new TypeError('fetch failed'))).toBe(true)
	})

	it('does not retry programming errors', () => {
		expect(isTransientError(new Error('undefined is not a function'))).toBe(false)
		expect(isTransientError(new TypeError('x is not a function'))).toBe(false)
	})
})

describe('parseRetryAfter', () => {
	const now = new Date('2026-11-20T12:00:00Z')

	it('reads delta seconds', () => {
		expect(parseRetryAfter('3', now)).toBe(3000)
	})

	it('reads an HTTP date', () => {
		expect(parseRetryAfter('Fri, 20 Nov 2026 12:00:05 GMT', now)).toBe(5000)
	})

	it('treats a past date as no wait', () => {
		expect(parseRetryAfter('Fri, 20 Nov 2026 11:00:00 GMT', now)).toBe(0)
	})

	it('ignores a missing or malformed header', () => {
		expect(parseRetryAfter(null, now)).toBeUndefined()
		expect(parseRetryAfter('soon', now)).toBeUndefined()
	})
})
