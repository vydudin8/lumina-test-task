import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll } from 'vitest'
import { createDb, type Db } from '../db/client.ts'
import { databaseName, withAdminClient } from '../db/migrate.ts'
import { retry } from '../lib/retry.ts'

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://lumina:lumina@localhost:5432/lumina_test'
export const TEMPLATE_NAME = `${databaseName(TEST_DATABASE_URL)}_template`

function urlFor(name: string) {
	const url = new URL(TEST_DATABASE_URL)
	url.pathname = `/${name}`
	return url.toString()
}

// Postgres refuses concurrent clones of one template with 55006 (object_in_use); wait and try again.
const isTemplateBusy = (error: unknown) => (error as { code?: string }).code === '55006'

// Each test file gets its own database cloned from the migrated template (see global-setup.ts).
export function useTestDb() {
	const name = `${databaseName(TEST_DATABASE_URL)}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
	const context = {} as { db: Db; url: string }

	beforeAll(async () => {
		await withAdminClient(TEST_DATABASE_URL, (client) =>
			retry(() => client.query(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_NAME}"`), {
				isRetryable: isTemplateBusy,
				maxAttempts: 20,
				baseMs: 50,
			}),
		)
		context.url = urlFor(name)
		context.db = createDb(context.url)
	})

	afterAll(async () => {
		await context.db?.$client.end()
		await withAdminClient(TEST_DATABASE_URL, (client) => client.query(`DROP DATABASE IF EXISTS "${name}"`))
	})

	return context
}
