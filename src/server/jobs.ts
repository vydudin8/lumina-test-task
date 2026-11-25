import { and, asc, eq, gte, sql } from 'drizzle-orm'
import type { Db, Executor } from './db/client.ts'
import { jobs } from './db/schema.ts'
import { stoppableSleep, type Clock } from './lib/clock.ts'
import { failureText } from './lib/errors.ts'
import { isTransientError, retry, type RetryOptions } from './lib/retry.ts'
import type { Logger } from './log.ts'

export const JOB_KINDS = { pull: 'provider.pull', lines: 'campaign.lines' } as const

export type JobRow = typeof jobs.$inferSelect
// lastTry: a failure now is final, nothing runs this job again. stopping: the process is shutting down; a handler that
// works in steps checks it between them and throws JobInterrupted, and the job is queued again.
export type JobHandler = (job: JobRow, lastTry: boolean, stopping: AbortSignal) => Promise<void>

export class JobInterrupted extends Error {
	constructor() {
		super('Interrupted by a shutdown')
		this.name = 'JobInterrupted'
	}
}

export interface JobDeps {
	db: Db
	log: Logger
	clock: Clock
	retry: RetryOptions
	handlers: Record<string, JobHandler>
}

// Handlers must be idempotent and resumable: a transient failure runs one again, and a crash runs it from the top.
const MAX_ATTEMPTS = 3
const ACTIVE = sql.raw(`status IN ('queued', 'running')`)

// Joins the transaction that makes the work necessary. Returns the job already active under this kind and key, if any.
export async function enqueueJob(
	executor: Executor,
	input: { kind: string; key: string; payload?: Record<string, unknown>; createdBy: string },
	now: Date,
) {
	const [created] = await executor
		.insert(jobs)
		.values({ ...input, createdAt: now })
		.onConflictDoNothing({ target: [jobs.kind, jobs.key], where: ACTIVE })
		.returning()
	if (created) return { job: created, created: true }
	const [active] = await executor
		.select()
		.from(jobs)
		.where(and(eq(jobs.kind, input.kind), eq(jobs.key, input.key), ACTIVE))
	return { job: active!, created: false }
}

// shortcut: with one app server, whatever is running at boot is an orphan. Several servers need a lease or heartbeat
// per job first, or one server would steal the jobs of another.
export async function requeueOrphans(db: Db, now: Date) {
	// Every claim counts an attempt, so a job interrupted MAX_ATTEMPTS times (one that takes the process down with it)
	// stops here instead of crashing every boot.
	await db
		.update(jobs)
		.set({ status: 'failed', error: 'Interrupted by a restart too many times', finishedAt: now })
		.where(and(eq(jobs.status, 'running'), gte(jobs.attempts, MAX_ATTEMPTS)))
	const orphans = await db
		.update(jobs)
		.set({ status: 'queued', startedAt: null })
		.where(eq(jobs.status, 'running'))
		.returning({ id: jobs.id })
	return orphans.length
}

async function claim(deps: JobDeps) {
	const now = deps.clock()
	return deps.db.transaction(async (tx) => {
		const [next] = await tx
			.select({ id: jobs.id })
			.from(jobs)
			.where(eq(jobs.status, 'queued'))
			.orderBy(asc(jobs.id))
			.limit(1)
			.for('update', { skipLocked: true })
		if (!next) return null
		const [job] = await tx
			.update(jobs)
			.set({ status: 'running', attempts: sql`${jobs.attempts} + 1`, startedAt: now })
			.where(eq(jobs.id, next.id))
			.returning()
		return job!
	})
}

// Claims one job, runs it outside any transaction (it can take minutes) and records how it ended. A transient failure
// is tried again with backoff, a few times; any other failure stays `failed`, with its text, for a person to see.
export async function runNextJob(deps: JobDeps, stopping = new AbortController().signal) {
	const job = await claim(deps)
	if (!job) return false
	const log = deps.log.child({ jobId: job.id, kind: job.kind })
	const handler = deps.handlers[job.kind]
	let tries = 1
	try {
		if (!handler) throw new Error(`No handler for job kind ${job.kind}`)
		log.info({ attempt: job.attempts }, 'job started')
		await retry(
			(attempt) => {
				tries = attempt
				return handler(job, attempt >= MAX_ATTEMPTS, stopping)
			},
			{
				...deps.retry,
				maxAttempts: MAX_ATTEMPTS,
				isRetryable: isTransientError,
				onRetry: ({ attempt, delayMs, error }) =>
					log.warn({ attempt, delayMs, cause: failureText(error) }, 'job failed with a transient error, retrying'),
			},
		)
		await finish(deps, job.id, tries, { status: 'done', error: null })
		log.info('job done')
	} catch (error) {
		if (error instanceof JobInterrupted) {
			// The try in progress does not count (the claim counted it), so a job cut short by deploys never runs out.
			await deps.db
				.update(jobs)
				.set({ status: 'queued', startedAt: null, attempts: sql`${jobs.attempts} + ${tries - 2}` })
				.where(eq(jobs.id, job.id))
			log.info('job interrupted by a shutdown; queued again')
			return true
		}
		// Not the error itself: a database error's message and params carry every value of the query, contacts included.
		log.error({ cause: failureText(error) }, 'job failed')
		await finish(deps, job.id, tries, { status: 'failed', error: failureText(error) })
	}
	return true
}

const finish = (deps: JobDeps, id: number, tries: number, values: Pick<typeof jobs.$inferInsert, 'status' | 'error'>) =>
	deps.db
		.update(jobs)
		.set({ ...values, attempts: sql`${jobs.attempts} + ${tries - 1}`, finishedAt: deps.clock() })
		.where(eq(jobs.id, id))

// Runs jobs until none is queued; what the loop below does, once, for tests and the seed.
export async function runPendingJobs(deps: JobDeps) {
	let ran = 0
	while (await runNextJob(deps)) ran++
	return ran
}

// Same shape as the send worker: poll, sleeps that stop() cuts short, errors logged. stop() asks the current job to
// stop at its next step; `done` settles once it has.
export function startJobRunner(
	deps: JobDeps,
	{ intervalMs = 500, sleep }: { intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
) {
	let stopped = false
	const stopping = new AbortController()
	const pause = sleep ?? stoppableSleep(stopping.signal)
	const done = (async () => {
		try {
			const requeued = await requeueOrphans(deps.db, deps.clock())
			if (requeued > 0) deps.log.warn({ requeued }, 'jobs left running by the last process were queued again')
		} catch (error) {
			deps.log.error({ err: error }, 'job runner could not requeue orphans')
		}
		while (!stopped) {
			try {
				if (await runNextJob(deps, stopping.signal)) continue
			} catch (error) {
				deps.log.error({ err: error }, 'job runner error')
			}
			await pause(intervalMs)
		}
	})()
	return {
		stop: () => {
			stopped = true
			stopping.abort()
		},
		done,
	}
}
