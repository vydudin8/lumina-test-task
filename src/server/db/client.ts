import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.ts'

export function createDb(url: string) {
	return drizzle({ client: new pg.Pool({ connectionString: url }), schema, casing: 'snake_case' })
}

export type Db = ReturnType<typeof createDb>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
// Store functions accept either, so callers decide the transaction boundary.
export type Executor = Db | Tx
