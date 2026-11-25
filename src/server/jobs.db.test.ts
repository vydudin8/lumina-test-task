import { eq } from 'drizzle-orm'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { jobs } from './db/schema.ts'
import {
	enqueueJob,
	JobInterrupted,
	requeueOrphans,
	runPendingJobs,
	startJobRunner,
	type JobDeps,
	type JobHandler,
} from './jobs.ts'
import { HttpError } from './lib/retry.ts'
import { createLogger } from './log.ts'
import { useTestDb } from './test/db.ts'

const now = new Date('2026-11-20T12:00:00Z')

describe('job runner', () => {
	const t = useTestDb()
	const depsWith = (handlers: Record<string, JobHandler>, log = createLogger({ level: 'silent' })): JobDeps => ({
		db: t.db,
		log,
		clock: () => now,
		retry: { rng: () => 0.5, sleep: () => Promise.resolve() },
		handlers,
	})
	const enqueue = (kind: string, key: string) => enqueueJob(t.db, { kind, key, createdBy: 'usr_rep_tom' }, now)
	const row = async (id: number) => (await t.db.select().from(jobs).where(eq(jobs.id, id)))[0]!

	it('runs each queued job once, even with two runners at the same time', async () => {
		const ran: string[] = []
		const deps = depsWith({
			work: async (job) => {
				await new Promise((resolve) => setTimeout(resolve, 5))
				ran.push(job.key)
			},
		})
		const queued = await Promise.all(['a', 'b', 'c', 'd'].map((key) => enqueue('work', key)))
		const counts = await Promise.all([runPendingJobs(deps), runPendingJobs(deps)])

		expect(ran.sort()).toEqual(['a', 'b', 'c', 'd'])
		expect(counts[0] + counts[1]).toBe(4)
		for (const { job } of queued)
			expect(await row(job.id)).toMatchObject({ status: 'done', attempts: 1, error: null, finishedAt: now })
	})

	it('keeps one active job per kind and key, and allows another once it has ended', async () => {
		const first = await enqueue('once', 'x')
		const again = await enqueue('once', 'x')
		expect(first.created).toBe(true)
		expect(again).toMatchObject({ created: false, job: { id: first.job.id } })
		expect((await enqueue('other', 'x')).created).toBe(true)

		await runPendingJobs(depsWith({ once: () => Promise.resolve(), other: () => Promise.resolve() }))
		expect((await enqueue('once', 'x')).created).toBe(true)
		// The index is the guard, not only the code above.
		await expect(
			t.db.insert(jobs).values({ kind: 'once', key: 'x', createdBy: 'usr_rep_tom', createdAt: now }),
		).rejects.toMatchObject({ cause: { constraint: 'jobs_active_key' } })
		await runPendingJobs(depsWith({ once: () => Promise.resolve() }))
	})

	it('marks a failed job with its error and no personal data, and does not retry what is not transient', async () => {
		let calls = 0
		const logged: string[] = []
		const log = createLogger(
			{ level: 'info' },
			new Writable({
				write(chunk: Buffer, _encoding, done) {
					logged.push(chunk.toString())
					done()
				},
			}),
		)
		const { job: refused } = await enqueue('refused', 'k')
		const { job: broken } = await enqueue('broken', 'k')
		await runPendingJobs(
			depsWith(
				{
					refused: () => {
						calls++
						return Promise.reject(new HttpError(404, 'GET /clay/tables/companies -> 404'))
					},
					// What a failed query says: the statement and its values.
					broken: () =>
						Promise.reject(new Error('Failed query: insert into contacts params: Ada Lovelace,ada@example.com')),
				},
				log,
			),
		)
		expect(calls).toBe(1)
		expect(await row(refused.id)).toMatchObject({
			status: 'failed',
			attempts: 1,
			error: 'GET /clay/tables/companies -> 404',
			finishedAt: now,
		})
		const stored = await row(broken.id)
		expect(stored).toMatchObject({ status: 'failed', error: 'Error' })
		expect(JSON.stringify(stored)).not.toMatch(/Ada|example\.com/)
		expect(logged.join('')).toContain('job failed')
		expect(logged.join('')).not.toMatch(/Ada|example\.com/)
	})

	it('has no handler for an unknown kind: failed, not stuck', async () => {
		const { job } = await enqueue('nobody', 'k')
		await runPendingJobs(depsWith({}))
		expect(await row(job.id)).toMatchObject({ status: 'failed', error: 'Error' })
	})

	it('retries a transient failure, a few times, and then gives up', async () => {
		let flaky = 0
		const lastTries: boolean[] = []
		const { job: recovers } = await enqueue('flaky', 'k')
		const { job: gone } = await enqueue('down', 'k')
		await runPendingJobs(
			depsWith({
				flaky: () => (++flaky < 3 ? Promise.reject(new HttpError(503, 'unavailable')) : Promise.resolve()),
				down: (_job, lastTry) => {
					lastTries.push(lastTry)
					return Promise.reject(new HttpError(503, 'unavailable'))
				},
			}),
		)
		expect(await row(recovers.id)).toMatchObject({ status: 'done', attempts: 3, error: null })
		// Only the third try is told it is the last, so a handler knows when its failure is final.
		expect(lastTries).toEqual([false, false, true])
		expect(await row(gone.id)).toMatchObject({ status: 'failed', attempts: 3, error: 'unavailable' })
	})

	it('queues jobs a dead process left running again, once, and runs them', async () => {
		const { job } = await enqueue('orphan', 'k')
		await t.db.update(jobs).set({ status: 'running', startedAt: now, attempts: 1 }).where(eq(jobs.id, job.id))
		const handlers = { orphan: vi.fn(() => Promise.resolve()) }
		expect(await runPendingJobs(depsWith(handlers))).toBe(0)

		expect(await requeueOrphans(t.db, now)).toBe(1)
		expect(await row(job.id)).toMatchObject({ status: 'queued', startedAt: null })
		expect(await runPendingJobs(depsWith(handlers))).toBe(1)
		expect(handlers.orphan).toHaveBeenCalledTimes(1)
		expect(await row(job.id)).toMatchObject({ status: 'done', attempts: 2 })
	})

	it('gives up on a job that was interrupted by a restart three times, instead of crashing every boot', async () => {
		const { job } = await enqueue('poison', 'k')
		await t.db.update(jobs).set({ status: 'running', startedAt: now, attempts: 3 }).where(eq(jobs.id, job.id))
		expect(await requeueOrphans(t.db, now)).toBe(0)
		expect(await row(job.id)).toMatchObject({ status: 'failed', finishedAt: now, error: expect.any(String) as string })
		// No longer active, so the same key can be queued again by hand.
		expect((await enqueue('poison', 'k')).created).toBe(true)
	})

	it('polls in the background and stops when told to', async () => {
		const orphan = await enqueue('boot', 'orphan')
		await t.db.update(jobs).set({ status: 'running', startedAt: now }).where(eq(jobs.id, orphan.job.id))
		const handled: string[] = []
		const runner = startJobRunner(
			depsWith({
				boot: (job) => {
					handled.push(job.key)
					return Promise.resolve()
				},
			}),
			{ intervalMs: 5 },
		)
		const late = await enqueue('boot', 'late')
		await vi.waitFor(async () => expect((await row(late.job.id)).status).toBe('done'))
		runner.stop()
		await runner.done
		expect(handled.sort()).toEqual(['late', 'orphan'])
	})

	it('on stop, asks the running job to stop at its next step and queues it again without counting the try', async () => {
		const { job } = await enqueue('steps', 'k')
		let inside!: () => void
		const running = new Promise<void>((resolve) => (inside = resolve))
		const runner = startJobRunner(
			depsWith({
				steps: async (_job, _lastTry, stopping) => {
					inside()
					await new Promise((resolve) => stopping.addEventListener('abort', resolve, { once: true }))
					throw new JobInterrupted()
				},
			}),
			{ intervalMs: 60_000 },
		)
		await running
		runner.stop()
		await runner.done
		expect(await row(job.id)).toMatchObject({ status: 'queued', attempts: 0, startedAt: null, finishedAt: null })
	})
})
