import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { useTestDb } from '../test/db.ts'

describe('createDb on a real database', () => {
	const t = useTestDb()

	it('has Postgres end a transaction left waiting for 5 minutes, so a vanished client stops holding row locks', async () => {
		const { rows } = await t.db.execute(sql`SHOW idle_in_transaction_session_timeout`)
		expect(rows).toEqual([{ idle_in_transaction_session_timeout: '5min' }])
	})
})
