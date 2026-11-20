import type { ProviderName } from '#common/settings.ts'
import { eq, sql } from 'drizzle-orm'
import type { Executor } from '../../db/client.ts'
import { ingestionRuns, rawRecords } from '../../db/schema.ts'
import { contentHash, type ParsedRecord } from './core.ts'

export type IngestionRun = typeof ingestionRuns.$inferSelect

export async function startRun(db: Executor, provider: ProviderName, triggeredBy: string, now: Date) {
	const [run] = await db.insert(ingestionRuns).values({ provider, triggeredBy, startedAt: now }).returning()
	return run!
}

// Upsert on (provider, kind, external_id, content_hash): new versions are inserted, unchanged ones only get last_seen_*.
export async function saveRecords(
	db: Executor,
	provider: ProviderName,
	runId: number,
	records: ParsedRecord[],
	now: Date,
) {
	let inserted = 0
	for (let i = 0; i < records.length; i += 500) {
		const rows = await db
			.insert(rawRecords)
			.values(
				records.slice(i, i + 500).map((record) => ({
					runId,
					lastSeenRunId: runId,
					provider,
					kind: record.kind,
					externalId: record.externalId,
					payload: record.payload,
					contentHash: contentHash(record.payload),
					fetchedAt: now,
					lastSeenAt: now,
				})),
			)
			.onConflictDoUpdate({
				target: [rawRecords.provider, rawRecords.kind, rawRecords.externalId, rawRecords.contentHash],
				set: { lastSeenRunId: sql`excluded.last_seen_run_id`, lastSeenAt: sql`excluded.last_seen_at` },
			})
			// xmax = 0 only for rows this statement inserted (not updated).
			.returning({ inserted: sql<boolean>`xmax = 0` })
		inserted += rows.filter((row) => row.inserted).length
	}
	return { new: inserted, unchanged: records.length - inserted }
}

export async function finishRun(db: Executor, runId: number, values: Partial<typeof ingestionRuns.$inferInsert>) {
	const [run] = await db.update(ingestionRuns).set(values).where(eq(ingestionRuns.id, runId)).returning()
	return run!
}
