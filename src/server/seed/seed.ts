import { count, eq, sql } from 'drizzle-orm'
import { audit, systemActor } from '../audit.ts'
import type { Db } from '../db/client.ts'
import { fxRates, icpVersions, seedRuns, suppressions, templates } from '../db/schema.ts'
import { personKey, personKeyHash } from '../policy/person-key.ts'
import { DEFAULT_ICP_RULES, DEFAULT_TEMPLATES } from './defaults.ts'
import { fixturesChecksum, readFixture, type History } from './fixtures.ts'
import { SEED_USERS, seedUsers } from './users.ts'

export const SEED_VERSION = 1
const DAY_MS = 24 * 60 * 60 * 1000

// Idempotent: one transaction, inserts keyed on natural keys with ON CONFLICT DO NOTHING. Safe to run on every start.
export async function seed(db: Db, { now }: { now: Date }) {
	const checksum = fixturesChecksum()
	const history = readFixture<History>('history.json')
	const actor = systemActor('seed')

	await db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('seed'))`)

		const [previous] = await tx.select().from(seedRuns).where(eq(seedRuns.version, SEED_VERSION))
		if (previous && previous.checksum !== checksum) {
			throw new Error(`Fixtures changed since this database was seeded (version ${SEED_VERSION}). Run pnpm seed:reset.`)
		}

		await seedUsers(tx)
		await tx
			.insert(fxRates)
			.values(
				readFixture<{ currency: string; rate: string; as_of: string }[]>('fx-rates.json').map(
					({ currency, rate, as_of }) => ({ currency, rate, asOf: as_of }),
				),
			)
			.onConflictDoNothing()
		await tx.insert(templates).values(DEFAULT_TEMPLATES).onConflictDoNothing()

		const [{ icpCount }] = (await tx.select({ icpCount: count() }).from(icpVersions)) as [{ icpCount: number }]
		if (icpCount === 0) {
			const lead = SEED_USERS.find((user) => user.role === 'lead')!
			await tx.insert(icpVersions).values({ rules: DEFAULT_ICP_RULES, createdBy: lead.id, createdAt: now })
		}

		const added = await tx
			.insert(suppressions)
			.values(
				history.optOuts.map((optOut) => ({
					personKeyHash: personKeyHash(personKey(optOut.email)),
					reason: 'opt_out',
					source: optOut.source,
					createdBy: actor.id,
					at: new Date(now.getTime() - optOut.daysAgo * DAY_MS),
				})),
			)
			.onConflictDoNothing()
			.returning()
		for (const suppression of added) {
			await audit(tx, {
				actor,
				action: 'suppression.added',
				entityType: 'suppression',
				entityId: suppression.id,
				reason: suppression.reason,
				result: { source: suppression.source },
			})
		}

		await tx.insert(seedRuns).values({ version: SEED_VERSION, checksum, at: now }).onConflictDoNothing()
	})
}
