export class HttpError extends Error {
	readonly status: number
	readonly retryAfterMs: number | undefined

	constructor(status: number, message: string, retryAfterMs?: number) {
		super(message)
		this.name = 'HttpError'
		this.status = status
		this.retryAfterMs = retryAfterMs
	}
}

export interface RetryOptions {
	isRetryable?: (error: unknown) => boolean
	maxAttempts?: number
	baseMs?: number
	capMs?: number
	rng?: () => number
	sleep?: (ms: number) => Promise<void>
	onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Exponential backoff with full jitter. Retry-After from the server wins over the computed delay.
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
	const {
		isRetryable = isTransientError,
		maxAttempts = 6,
		baseMs = 500,
		capMs = 30_000,
		rng = Math.random,
		sleep = defaultSleep,
		onRetry,
	} = options

	for (let attempt = 1; ; attempt++) {
		try {
			return await fn(attempt)
		} catch (error) {
			if (attempt >= maxAttempts || !isRetryable(error)) throw error

			const retryAfterMs = error instanceof HttpError ? error.retryAfterMs : undefined
			// Retry-After is honoured but capped, so a provider cannot park us (and the locks we hold) for an hour.
			const delayMs =
				retryAfterMs !== undefined
					? Math.min(retryAfterMs, capMs)
					: Math.floor(rng() * Math.min(capMs, baseMs * 2 ** (attempt - 1)))
			onRetry?.({ attempt, delayMs, error })
			await sleep(delayMs)
		}
	}
}

// Timeouts, network failures, 429 and 5xx are worth retrying; other 4xx are our fault and never succeed on retry.
export function isTransientError(error: unknown): boolean {
	if (error instanceof HttpError) return error.status === 429 || error.status >= 500
	if (error instanceof Error && error.name === 'TimeoutError') return true
	return error instanceof TypeError && error.message === 'fetch failed'
}

export function parseRetryAfter(header: string | null, now: Date): number | undefined {
	if (!header) return undefined
	if (/^\d+$/.test(header.trim())) return Number(header) * 1000

	const at = Date.parse(header)
	return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime())
}
