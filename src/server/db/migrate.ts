import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { createDb, type Db } from './client.ts'

export const MIGRATIONS_DIR = `${import.meta.dirname}/migrations`

export async function runMigrations(db: Db) {
	await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
}

// Connects to the server's maintenance database, so the target database itself may not exist yet.
export async function withAdminClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
	const adminUrl = new URL(url)
	adminUrl.pathname = '/postgres'
	const client = new pg.Client({ connectionString: adminUrl.toString() })
	await client.connect()
	try {
		return await fn(client)
	} finally {
		await client.end()
	}
}

export function databaseName(url: string) {
	const name = new URL(url).pathname.slice(1)
	if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unsupported database name: ${name}`)
	return name
}

export async function ensureDatabase(url: string) {
	const name = databaseName(url)
	await withAdminClient(url, async (client) => {
		const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
		if (!rowCount) await client.query(`CREATE DATABASE "${name}"`)
	})
}

if (import.meta.main) {
	const url = process.env.DATABASE_URL
	if (!url) throw new Error('DATABASE_URL is not set')
	await ensureDatabase(url)
	const db = createDb(url)
	await runMigrations(db)
	await db.$client.end()
	console.log('migrations applied')
}
