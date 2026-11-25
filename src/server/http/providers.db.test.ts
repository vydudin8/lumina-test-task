import { count, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { ingestionRuns, jobs, rawRecords } from '../db/schema.ts'
import { jobRunnerDeps } from '../job-handlers.ts'
import { runPendingJobs } from '../jobs.ts'
import { seedUsers } from '../seed/users.ts'
import { call, createTestApp, loginAs, testDeps, type FetchApp } from '../test/app.ts'
import { useTestDb } from '../test/db.ts'

describe('providers API', () => {
	const t = useTestDb()
	let app: FetchApp
	let cookie: string
	// What the job runner does in the real server, run to the end.
	let runJobs: () => Promise<number>

	beforeAll(async () => {
		await seedUsers(t.db)
		app = createTestApp(t.db)
		runJobs = () => runPendingJobs(jobRunnerDeps(testDeps(t.db)))
		cookie = await loginAs(app, 'usr_rep_tom')
	})

	it('requires a picked user', async () => {
		expect((await call(app, '/api/providers')).status).toBe(401)
	})

	it('pulls a provider on request and reports the run on its panel', async () => {
		const pull = await call(app, '/api/providers/apollo/pull', { method: 'POST', cookie })
		expect(pull.status).toBe(202)
		await runJobs()

		const { providers } = (await (await call(app, '/api/providers', { cookie })).json()) as {
			providers: {
				provider: string
				lastRun: { status: string; creditsUsed: string; recordsRejected: number } | null
				records: { company: number; contact: number }
			}[]
		}
		const apollo = providers.find((panel) => panel.provider === 'apollo')
		expect(apollo).toMatchObject({
			lastRun: { status: 'succeeded_with_errors', creditsUsed: '432', recordsRejected: 1 },
			records: { company: 130, contact: 301 },
		})
		expect(providers.find((panel) => panel.provider === 'clay')?.lastRun).toBeNull()
	})

	it('rejects an unknown provider', async () => {
		expect((await call(app, '/api/providers/linkedin/pull', { method: 'POST', cookie })).status).toBe(404)
	})

	it('lists raw records with filters and opens one with its full payload', async () => {
		const list = (await (await call(app, '/api/raw-records?provider=apollo&kind=company', { cookie })).json()) as {
			total: number
			records: { id: number; label: string }[]
		}
		expect(list.total).toBe(130)
		expect(list.records).toHaveLength(20)

		const record = (await (await call(app, `/api/raw-records/${list.records[0]!.id}`, { cookie })).json()) as {
			record: { payload: { id: string; name: string } }
		}
		expect(record.record.payload.name).toBe(list.records[0]!.label)
	})

	it('lists runs without their payloads and opens one with its rejected records', async () => {
		const list = (await (await call(app, '/api/ingestion-runs', { cookie })).json()) as {
			total: number
			nextCursor: string | null
			runs: { id: number; provider: string; errorCount: number; errors?: unknown }[]
		}
		expect(list).toMatchObject({ total: 1, nextCursor: null, runs: [{ provider: 'apollo', errorCount: 1 }] })
		expect(list.runs[0]!.errors).toBeUndefined()

		const detail = (await (await call(app, `/api/ingestion-runs/${list.runs[0]!.id}`, { cookie })).json()) as {
			run: { errors: { problem: string }[] }
		}
		expect(detail.run.errors).toMatchObject([{ problem: 'missing name' }])
		expect((await call(app, '/api/ingestion-runs/999999', { cookie })).status).toBe(404)
	})

	it('lists the records each run received, new and unchanged', async () => {
		const runs = async () =>
			(
				(await (await call(app, '/api/ingestion-runs?provider=apollo', { cookie })).json()) as {
					runs: { id: number }[]
				}
			).runs
		const [first] = await runs()
		await call(app, '/api/providers/apollo/pull', { method: 'POST', cookie })
		await runJobs()
		const [second] = await runs()

		const total = async (query: string) =>
			((await (await call(app, `/api/raw-records?${query}`, { cookie })).json()) as { total: number }).total
		expect(await total(`runId=${first!.id}&outcome=new`)).toBe(431)
		expect(await total(`runId=${second!.id}`)).toBe(431)
		expect(await total(`runId=${second!.id}&outcome=unchanged`)).toBe(431)
		expect(await total(`runId=${second!.id}&outcome=new`)).toBe(0)
		expect(await total(`runId=${second!.id}&outcome=unchanged&kind=company`)).toBe(130)
		expect((await call(app, '/api/raw-records?outcome=new', { cookie })).status).toBe(400)
	})

	it('pages raw records with a cursor: records added meanwhile never repeat or hide a row', async () => {
		type Page = { total: number; nextCursor: string | null; records: { id: number; label: string }[] }
		const page = async (cursor?: string) =>
			(await (
				await call(app, `/api/raw-records?provider=apollo&kind=contact${cursor ? `&cursor=${cursor}` : ''}`, {
					cookie,
				})
			).json()) as Page
		const seen: number[] = []
		let current = await page()
		const total = current.total
		seen.push(...current.records.map((row) => row.id))

		// A parallel pull adds a record that sorts onto the first page; offset paging would repeat a row now.
		const [run] = await t.db.select({ id: ingestionRuns.id }).from(ingestionRuns).limit(1)
		const now = new Date()
		await t.db.insert(rawRecords).values({
			runId: run!.id,
			lastSeenRunId: run!.id,
			provider: 'apollo',
			kind: 'contact',
			externalId: 'test-sorts-first',
			payload: { name: '000 Sorts first' },
			contentHash: 'test',
			fetchedAt: now,
			lastSeenAt: now,
		})

		while (current.nextCursor) {
			current = await page(current.nextCursor)
			seen.push(...current.records.map((row) => row.id))
		}
		expect(seen).toHaveLength(total)
		expect(new Set(seen).size).toBe(total)
		expect((await call(app, '/api/raw-records?cursor=garbage', { cookie })).status).toBe(400)
	})

	it('pages runs that started at the same moment by id', async () => {
		const startedAt = new Date('2026-11-01T09:00:00Z')
		await t.db
			.insert(ingestionRuns)
			.values(Array.from({ length: 20 }, () => ({ provider: 'clay', triggeredBy: 'test', startedAt })))
		type Page = { nextCursor: string | null; runs: { id: number }[] }
		const page = async (cursor?: string) =>
			(await (
				await call(app, `/api/ingestion-runs?provider=clay${cursor ? `&cursor=${cursor}` : ''}`, { cookie })
			).json()) as Page
		const first = await page()
		const second = await page(first.nextCursor!)
		expect(first.runs).toHaveLength(15)
		expect(second).toMatchObject({ nextCursor: null })
		expect(new Set([...first.runs, ...second.runs].map((run) => run.id)).size).toBe(20)
	})
})

describe('background pulls', () => {
	const t = useTestDb()
	let app: FetchApp
	let cookie: string
	let runJobs: () => Promise<number>

	beforeAll(async () => {
		await seedUsers(t.db)
		app = createTestApp(t.db)
		runJobs = () => runPendingJobs(jobRunnerDeps(testDeps(t.db)))
		cookie = await loginAs(app, 'usr_rep_tom')
	})

	type Panels = {
		providers: { provider: string; lastRun: { status: string } | null; activeRun: { status: string } | null }[]
	}
	const panelOf = async (provider: string) =>
		((await (await call(app, '/api/providers', { cookie })).json()) as Panels).providers.find(
			(panel) => panel.provider === provider,
		)!

	it('answers a pull with 202 and a queued run; a second request while it is active gets the same run', async () => {
		const first = await call(app, '/api/providers/factset/pull', { method: 'POST', cookie })
		expect(first.status).toBe(202)
		const queued = (await first.json()) as { run: { id: number; status: string }; jobId: number; created: boolean }
		expect(queued).toMatchObject({ run: { status: 'queued' }, created: true })
		// Nothing was fetched in the request.
		expect(await t.db.select({ n: count() }).from(rawRecords).where(eq(rawRecords.provider, 'factset'))).toEqual([
			{ n: 0 },
		])

		const second = await call(app, '/api/providers/factset/pull', { method: 'POST', cookie })
		expect(second.status).toBe(202)
		await expect(second.json()).resolves.toMatchObject({
			run: { id: queued.run.id },
			jobId: queued.jobId,
			created: false,
		})
		expect(await t.db.select({ n: count() }).from(ingestionRuns).where(eq(ingestionRuns.provider, 'factset'))).toEqual([
			{ n: 1 },
		])
		expect(await panelOf('factset')).toMatchObject({ activeRun: { status: 'queued' }, lastRun: null })

		expect(await runJobs()).toBe(1)
		expect(await panelOf('factset')).toMatchObject({ activeRun: null, lastRun: { status: 'succeeded_with_errors' } })
		const [job] = await t.db.select().from(jobs).where(eq(jobs.id, queued.jobId))
		expect(job).toMatchObject({ status: 'done', kind: 'provider.pull', key: 'factset' })

		// Done is done: the next click is a new pull.
		const third = await call(app, '/api/providers/factset/pull', { method: 'POST', cookie })
		await expect(third.json()).resolves.toMatchObject({ created: true })
		await runJobs()
	})
})
