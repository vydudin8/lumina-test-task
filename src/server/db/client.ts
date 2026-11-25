import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.ts'

// An idle connection can die (Postgres restart, `seed:reset`). Without a listener pg's 'error' event ends the
// process; with one, the pool opens a new connection on the next query.
// A transaction left waiting this long is ended by Postgres, so a client that vanished (its host gone, not just the
// process) stops holding row locks after minutes, not after TCP keepalive notices hours later. Above the longest wait
// that is legitimate: the send worker holding a card through every mail retry, Retry-After included (about 3 min).
export const IDLE_IN_TRANSACTION_MS = 5 * 60_000

export function createDb(url: string, onIdleError: (error: Error) => void = (error) => console.error(error)) {
	const pool = new pg.Pool({ connectionString: url, idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_MS })
	pool.on('error', onIdleError)
	return drizzle({ client: pool, schema, casing: 'snake_case' })
}

export type Db = ReturnType<typeof createDb>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
// Store functions accept either, so callers decide the transaction boundary.
export type Executor = Db | Tx
