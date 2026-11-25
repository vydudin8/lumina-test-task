import pg from 'pg'
import { retry, type RetryOptions } from './lib/retry.ts'
import type { Logger } from './log.ts'

const CHANNEL = 'lumina_changes'
// Handed to subscribers after a reconnect: notices sent while the connection was down are gone, so they must refetch.
export const RESYNC = 'resync'

export type Listener = (payload: string) => void

export interface Hub {
	subscribe: (listener: Listener) => () => void
}

export interface PgHub extends Hub {
	// Resolves the first time LISTEN is active.
	ready: Promise<void>
	close: () => Promise<void>
}

// An unref'd timer, so a backoff in progress never holds a shutting-down process open.
const unrefSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref())

// One dedicated connection per process, outside the pool: LISTEN is bound to the session that ran it, and a pooled
// connection would be handed out and lose it. Every payload goes to every subscriber in this process.
export function createHub({
	url,
	log,
	retry: retryOptions,
}: {
	url: string
	log: Logger
	retry?: RetryOptions
}): PgHub {
	const listeners = new Set<Listener>()
	let closed = false
	let client: pg.Client | undefined
	let markReady!: () => void
	const ready = new Promise<void>((resolve) => (markReady = resolve))

	const emit = (payload: string) => {
		for (const listener of listeners) {
			try {
				listener(payload)
			} catch (error) {
				log.error({ err: error }, 'hub subscriber failed')
			}
		}
	}

	async function connect() {
		const next = new pg.Client({ connectionString: url, keepAlive: true })
		next.on('error', (error) => log.warn({ cause: error.message }, 'hub connection error'))
		next.on('notification', ({ channel, payload }) => {
			if (channel === CHANNEL && payload) emit(payload)
		})
		try {
			await next.connect()
			await next.query(`LISTEN ${CHANNEL}`)
		} catch (error) {
			await next.end().catch(() => {})
			throw error
		}
		return next
	}

	void (async () => {
		for (let reconnected = false; !closed; reconnected = true) {
			let live: pg.Client
			try {
				live = await retry(connect, {
					// Never gives up while open; an error can only reach here once close() was called.
					isRetryable: () => !closed,
					maxAttempts: Infinity,
					sleep: unrefSleep,
					onRetry: ({ attempt, delayMs, error }) =>
						log.warn({ attempt, delayMs, cause: (error as Error).message }, 'hub cannot listen, retrying'),
					...retryOptions,
				})
			} catch {
				return
			}
			if (closed) return void live.end().catch(() => {})
			client = live
			markReady()
			if (reconnected) emit(RESYNC)
			// pg emits 'end' after any drop, whether Postgres closed the session or the network did.
			await new Promise<void>((resolve) => live.once('end', resolve))
			if (!closed) log.warn('hub connection lost, reconnecting')
		}
	})()

	return {
		subscribe(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		ready,
		async close() {
			closed = true
			listeners.clear()
			await client?.end()
		},
	}
}
