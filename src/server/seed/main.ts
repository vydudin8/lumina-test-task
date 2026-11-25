import { createDb } from '../db/client.ts'
import { databaseName, ensureDatabase, runMigrations, withAdminClient } from '../db/migrate.ts'
import { systemClock } from '../lib/clock.ts'
import { createLogger } from '../log.ts'
import { ingestMissingProviders } from '../pipeline/ingest/index.ts'
import { ensureProfiles } from '../pipeline/resolve/store.ts'
import { seedHistory } from './history.ts'
import { seed } from './seed.ts'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set')

// Dev-only: wipes the database. Never part of the normal start-up path.
if (process.argv.includes('--reset')) {
	await withAdminClient(url, (client) => client.query(`DROP DATABASE IF EXISTS "${databaseName(url)}" WITH (FORCE)`))
	await ensureDatabase(url)
}

const db = createDb(url)
await runMigrations(db)
await seed(db, { now: new Date() })
await ingestMissingProviders(
	{
		db,
		log: createLogger({ level: process.env.LOG_LEVEL ?? 'info' }).child({ job: 'seed' }),
		clock: systemClock,
		providerBaseUrl: process.env.FAKE_WORLD_URL ?? 'http://localhost:4000',
		fetch: (input, init) => fetch(input, init),
		retry: {},
	},
	'system:seed',
)
// A database from before stored profiles has its records already pulled, so build the profiles from them once.
await ensureProfiles(db, new Date())
await seedHistory(db, new Date())
await db.$client.end()
console.log('seed complete')
