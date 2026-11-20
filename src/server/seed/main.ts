import { createDb } from '../db/client.ts'
import { databaseName, ensureDatabase, runMigrations, withAdminClient } from '../db/migrate.ts'
import { seedUsers } from './users.ts'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set')

// Dev-only: wipes the database. Never part of the normal start-up path.
if (process.argv.includes('--reset')) {
	await withAdminClient(url, (client) => client.query(`DROP DATABASE IF EXISTS "${databaseName(url)}" WITH (FORCE)`))
	await ensureDatabase(url)
}

const db = createDb(url)
await runMigrations(db)
await db.transaction(async (tx) => {
	await seedUsers(tx)
})
await db.$client.end()
console.log('seed complete')
