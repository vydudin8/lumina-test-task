import type { AppDeps } from './app.ts'
import { JOB_KINDS, type JobDeps, type JobHandler } from './jobs.ts'
import { writeLines } from './pipeline/campaign/store.ts'
import { executeRun } from './pipeline/ingest/index.ts'

// What each kind of job does. Both are safe to run again: a pull is an upsert, and the lines fill only empty cards.
// A pull is one request and one save, so a shutdown lets it finish; the lines stop between batches.
export function jobHandlers(deps: AppDeps): Record<string, JobHandler> {
	return {
		[JOB_KINDS.pull]: async (job, lastTry) =>
			void (await executeRun(
				{ ...deps, log: deps.log.child({ jobId: job.id }) },
				job.payload.runId as number,
				lastTry,
			)),
		[JOB_KINDS.lines]: (job, _lastTry, stopping) => writeLines(deps, job.payload.campaignId as number, stopping),
	}
}

export const jobRunnerDeps = (deps: AppDeps): JobDeps => ({
	db: deps.db,
	log: deps.log.child({ job: 'job-runner' }),
	clock: deps.clock,
	retry: deps.retry,
	handlers: jobHandlers(deps),
})
