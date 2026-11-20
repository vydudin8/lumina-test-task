import { sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Db } from '../db/client.ts'
import { suppressions } from '../db/schema.ts'
import { useTestDb } from '../test/db.ts'
import { seed } from './seed.ts'

const now = new Date('2026-11-20T12:00:00Z')

// Row count and an order-independent digest of every table, to compare whole-database states.
async function snapshot(db: Db) {
	const { rows: tables } = await db.execute<{ name: string }>(
		sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
	)
	const state: Record<string, { rows: number; digest: string }> = {}
	for (const { name } of tables) {
		const { rows } = await db.execute<{ rows: number; digest: string }>(
			sql.raw(
				`SELECT count(*)::int AS rows, md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest FROM "${name}" t`,
			),
		)
		state[name] = rows[0]!
	}
	return state
}

describe('seed', () => {
	const t = useTestDb()

	it('loads users, the default ICP, templates, FX rates and the 7 opt-outs', async () => {
		await seed(t.db, { now })
		const state = await snapshot(t.db)
		expect(state.users?.rows).toBe(3)
		expect(state.icp_versions?.rows).toBe(1)
		expect(state.templates?.rows).toBe(2)
		expect(state.fx_rates?.rows).toBe(4)
		expect(state.suppressions?.rows).toBe(7)
		expect(state.seed_runs?.rows).toBe(1)
	})

	it('is idempotent: running it again later leaves every table identical', async () => {
		const before = await snapshot(t.db)
		await seed(t.db, { now: new Date('2026-12-01T12:00:00Z') })
		expect(await snapshot(t.db)).toEqual(before)
	})

	it('stores opt-outs as hashes of the normalised email, never the email itself', async () => {
		const rows = await t.db.select().from(suppressions)
		const expected = createHash('sha256').update('ben.khan@otteryinfrastructure.co.uk').digest('hex')
		expect(rows.map((row) => row.personKeyHash)).toContain(expected)
		expect(JSON.stringify(rows)).not.toContain('@')
	})

	it('keeps ICP versions immutable', async () => {
		await expect(t.db.execute(sql`UPDATE icp_versions SET rules = '[]'`)).rejects.toMatchObject({
			cause: { message: /icp_versions is immutable/ },
		})
		await expect(t.db.execute(sql`DELETE FROM icp_versions`)).rejects.toThrow()
	})

	it('refuses to run over a database seeded from different fixtures', async () => {
		await t.db.execute(sql`UPDATE seed_runs SET checksum = 'stale'`)
		await expect(seed(t.db, { now })).rejects.toThrow(/seed:reset/)
	})
})
