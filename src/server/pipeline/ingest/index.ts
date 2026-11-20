import { PROVIDERS, type ProviderName } from '#common/settings.ts'
import { inArray } from 'drizzle-orm'
import type { Db } from '../../db/client.ts'
import { ingestionRuns } from '../../db/schema.ts'
import type { Clock } from '../../lib/clock.ts'
import type { RetryOptions } from '../../lib/retry.ts'
import type { Logger } from '../../log.ts'
import { resolveAll } from '../resolve/store.ts'
import { creditsFor, parseApollo, parseClay, parseFactset, type Parsed } from './core.ts'
import { pullApollo, pullClay, pullFactset, type Fetch } from './fetch.ts'
import { finishRun, saveRecords, startRun, type IngestionRun } from './store.ts'

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

// Each pull is its own run. All pages are fetched before anything is stored, so a failed pull stores nothing.
export async function runIngestion(
	deps: IngestDeps,
	provider: ProviderName,
	triggeredBy: string,
): Promise<IngestionRun> {
	const run = await startRun(deps.db, provider, triggeredBy, deps.clock())
	const log = deps.log.child({ runId: run.id, provider })
	log.info('ingestion started')

	try {
		const parsed = await pullAndParse(provider, deps, ({ attempt, delayMs, error }) =>
			log.warn({ attempt, delayMs, cause: describe(error) }, 'provider request failed, retrying'),
		)
		const saved = await saveRecords(deps.db, provider, run.id, parsed.records, deps.clock())
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
		const resolved = await deps.db.transaction((tx) => resolveAll(tx, deps.clock()))
		log.info(resolved, 'company master resolved')
		return finished
	} catch (error) {
		log.error({ cause: describe(error) }, 'ingestion failed')
		return finishRun(deps.db, run.id, {
			status: 'failed',
			finishedAt: deps.clock(),
			errors: [{ kind: 'request', externalId: null, problem: describe(error) }],
		})
	}
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
