import { createDb } from '../db/client.ts'
import { databaseName, runMigrations, withAdminClient } from '../db/migrate.ts'
import { TEMPLATE_NAME, TEST_DATABASE_URL } from './db.ts'

export default async function setup() {
	const prefix = databaseName(TEST_DATABASE_URL)
	await withAdminClient(TEST_DATABASE_URL, async (client) => {
		// Leftovers from interrupted runs.
		const { rows } = await client.query<{ datname: string }>(
			`SELECT datname FROM pg_database WHERE datname LIKE $1 || '\\_%'`,
			[prefix],
		)
		for (const { datname } of rows) await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`)
		await client.query(`CREATE DATABASE "${TEMPLATE_NAME}"`)
	})

	const url = new URL(TEST_DATABASE_URL)
	url.pathname = `/${TEMPLATE_NAME}`
	const db = createDb(url.toString())
	await runMigrations(db)
	await db.$client.end()
}
