import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.ts'

// An idle connection can die (Postgres restart, `seed:reset`). Without a listener pg's 'error' event ends the
// process; with one, the pool opens a new connection on the next query.
export function createDb(url: string, onIdleError: (error: Error) => void = (error) => console.error(error)) {
	const pool = new pg.Pool({ connectionString: url })
	pool.on('error', onIdleError)
	return drizzle({ client: pool, schema, casing: 'snake_case' })
}

export type Db = ReturnType<typeof createDb>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
// Store functions accept either, so callers decide the transaction boundary.
export type Executor = Db | Tx
