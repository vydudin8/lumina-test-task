import { PROVIDERS, type ProviderName } from '#common/settings.ts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/client.ts'
import { ingestionRuns, jobs } from '../../db/schema.ts'
import { enqueueJob, JOB_KINDS } from '../../jobs.ts'
import type { Clock } from '../../lib/clock.ts'
import { failureText } from '../../lib/errors.ts'
import { isTransientError, type RetryOptions } from '../../lib/retry.ts'
import type { Logger } from '../../log.ts'
import { resolveAll } from '../resolve/store.ts'
import { creditsFor, parseApollo, parseClay, parseFactset, type Parsed } from './core.ts'
import { pullApollo, pullClay, pullFactset, type Fetch } from './fetch.ts'
import { beginRun, findRun, finishRun, saveRecords, startRun, type IngestionRun } from './store.ts'

export interface IngestDeps {
	db: Db
	log: Logger
	clock: Clock
	providerBaseUrl: string
	fetch: Fetch
	retry: RetryOptions
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function pullAndParse(
	provider: ProviderName,
	deps: IngestDeps,
	onRetry: RetryOptions['onRetry'],
): Promise<Parsed> {
	const options = {
		baseUrl: deps.providerBaseUrl,
		fetch: deps.fetch,
		retry: { ...deps.retry, onRetry },
		now: deps.clock,
	}
	switch (provider) {
		case 'apollo':
			return parseApollo(await pullApollo(options))
		case 'factset':
			return parseFactset(await pullFactset(options))
		case 'clay':
			return parseClay(await pullClay(options))
	}
}

// Does the pull a run row stands for: all pages are fetched before anything is stored, so a failed pull stores
// nothing. The error is rethrown, so the job runner can retry what is transient; the run is marked failed only when no
// try follows (lastTry, or an error retrying cannot fix), so it never reads failed while a retry is still coming.
export async function executeRun(deps: IngestDeps, runId: number, lastTry = true): Promise<IngestionRun> {
	const run = await beginRun(deps.db, runId, deps.clock())
	if (!run) return findRun(deps.db, runId)
	// The column is plain text; ingestion_runs_provider keeps it to the three names.
	const provider = run.provider as ProviderName
	const log = deps.log.child({ runId: run.id, provider })
	log.info('ingestion started')

	try {
		const parsed = await pullAndParse(provider, deps, ({ attempt, delayMs, error }) =>
			log.warn({ attempt, delayMs, cause: describe(error) }, 'provider request failed, retrying'),
		)
		// shortcut: a crash after some batches were saved makes the re-run count them as unchanged, so new/unchanged
		// can be off for that run; the records themselves are right (saving is an upsert on the content hash).
		const saved = await saveRecords(deps.db, provider, run.id, parsed.records, deps.clock())
		const resolved = await deps.db.transaction((tx) => resolveAll(tx, deps.clock()))
		log.info(resolved, 'company master resolved')
		// Last, so a run that says it succeeded has its profiles too, whatever happened in between.
		const finished = await finishRun(deps.db, run.id, {
			status: parsed.errors.length ? 'succeeded_with_errors' : 'succeeded',
			finishedAt: deps.clock(),
			recordsReceived: parsed.received.company + parsed.received.contact,
			recordsNew: saved.new,
			recordsUnchanged: saved.unchanged,
			recordsRejected: parsed.errors.length,
			creditsUsed: creditsFor(provider, parsed.received).toString(),
			errors: parsed.errors,
		})
		log.info(
			{
				received: finished.recordsReceived,
				new: saved.new,
				unchanged: saved.unchanged,
				rejected: parsed.errors.length,
			},
			'ingestion finished',
		)
		for (const error of parsed.errors)
			log.warn({ kind: error.kind, externalId: error.externalId, problem: error.problem }, 'record rejected')
		return finished
	} catch (error) {
		// failureText, not the message: a database error's message repeats the query and every value it carried.
		const problem = failureText(error)
		log.error({ cause: problem }, 'ingestion failed')
		if (lastTry || !isTransientError(error))
			await finishRun(deps.db, run.id, {
				status: 'failed',
				finishedAt: deps.clock(),
				errors: [{ kind: 'request', externalId: null, problem }],
			})
		throw error
	}
}

// Synchronous pull, for the seed and for tests; the API enqueues one instead (enqueuePull).
export async function runIngestion(
	deps: IngestDeps,
	provider: ProviderName,
	triggeredBy: string,
): Promise<IngestionRun> {
	const run = await startRun(deps.db, provider, triggeredBy, deps.clock())
	return executeRun(deps, run.id).catch(() => findRun(deps.db, run.id))
}

// Creates the run row (queued, so the Providers page shows it at once) and its job together. A second request for a
// provider that is already queued or pulling gets the same run back instead of starting another.
export async function enqueuePull(db: Db, clock: Clock, provider: ProviderName, triggeredBy: string) {
	return db.transaction(async (tx) => {
		// Serialises the check below for one provider; the jobs_active_key index would refuse a second job anyway.
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`pull:${provider}`}))`)
		const now = clock()
		const [active] = await tx
			.select()
			.from(jobs)
			.where(and(eq(jobs.kind, JOB_KINDS.pull), eq(jobs.key, provider), inArray(jobs.status, ['queued', 'running'])))
		if (active) return { job: active, run: await findRun(tx, active.payload.runId as number), created: false }
		const run = await startRun(tx, provider, triggeredBy, now, 'queued')
		const { job } = await enqueueJob(
			tx,
			{ kind: JOB_KINDS.pull, key: provider, payload: { runId: run.id }, createdBy: triggeredBy },
			now,
		)
		return { job, run, created: true }
	})
}

// First ingestion at start-up. Providers that already have a successful run are left alone, so restarts add no runs.
export async function ingestMissingProviders(deps: IngestDeps, triggeredBy: string) {
	const done = await deps.db
		.selectDistinct({ provider: ingestionRuns.provider })
		.from(ingestionRuns)
		.where(inArray(ingestionRuns.status, ['succeeded', 'succeeded_with_errors']))
	const missing = PROVIDERS.filter((provider) => !done.some((row) => row.provider === provider))

	const runs: IngestionRun[] = []
	for (const provider of missing) runs.push(await runIngestion(deps, provider, triggeredBy))
	return runs
}
