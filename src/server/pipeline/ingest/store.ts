import type { ProviderName } from '#common/settings.ts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Executor } from '../../db/client.ts'
import { ingestionRunRecords, ingestionRuns, rawRecords } from '../../db/schema.ts'
import { contentHash, type ParsedRecord } from './core.ts'

export type IngestionRun = typeof ingestionRuns.$inferSelect

export async function startRun(
	db: Executor,
	provider: ProviderName,
	triggeredBy: string,
	now: Date,
	status: 'queued' | 'running' = 'running',
) {
	const [run] = await db.insert(ingestionRuns).values({ provider, triggeredBy, startedAt: now, status }).returning()
	return run!
}

// A queued run, or one the job runner starts again after a failure or a restart, begins from a clean slate. A run that
// already succeeded is left alone, so a job requeued after a crash that came too late does not pull twice.
export async function beginRun(db: Executor, runId: number, now: Date) {
	const [run] = await db
		.update(ingestionRuns)
		.set({ status: 'running', startedAt: now, finishedAt: null, errors: [] })
		.where(and(eq(ingestionRuns.id, runId), inArray(ingestionRuns.status, ['queued', 'running', 'failed'])))
		.returning()
	return run
}

export async function findRun(db: Executor, runId: number) {
	const [run] = await db.select().from(ingestionRuns).where(eq(ingestionRuns.id, runId))
	return run!
}

// Upsert on (provider, kind, external_id, content_hash): new versions are inserted, unchanged ones only get last_seen_*.
// Either way the run is linked to the record it received.
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
			.returning({ id: rawRecords.id, inserted: sql<boolean>`xmax = 0` })
		inserted += rows.filter((row) => row.inserted).length
		await db
			.insert(ingestionRunRecords)
			.values(rows.map((row) => ({ runId, rawRecordId: row.id })))
			.onConflictDoNothing()
	}
	return { new: inserted, unchanged: records.length - inserted }
}

export async function finishRun(db: Executor, runId: number, values: Partial<typeof ingestionRuns.$inferInsert>) {
	const [run] = await db.update(ingestionRuns).set(values).where(eq(ingestionRuns.id, runId)).returning()
	return run!
}
