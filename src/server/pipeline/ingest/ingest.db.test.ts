import { createFakeWorld } from '#fake-world/app.ts'
import { and, count, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { ingestionRuns, rawRecords } from '../../db/schema.ts'
import { createLogger } from '../../log.ts'
import { useTestDb } from '../../test/db.ts'
import { ingestMissingProviders, runIngestion, type IngestDeps } from './index.ts'

describe('ingestion', () => {
	const t = useTestDb()
	const sleeps: number[] = []
	let deps: IngestDeps

	beforeAll(() => {
		const world = createFakeWorld()
		deps = {
			db: t.db,
			log: createLogger({ level: 'silent' }),
			clock: () => new Date('2026-11-20T12:00:00Z'),
			providerBaseUrl: 'http://fake-world',
			fetch: (input, init) => Promise.resolve(world.app.fetch(new Request(input, init))),
			retry: {
				rng: () => 0.5,
				sleep: (ms) => {
					sleeps.push(ms)
					return Promise.resolve()
				},
			},
		}
	})

	const rawCount = async (provider: string, kind: 'company' | 'contact') => {
		const [row] = await t.db
			.select({ n: count() })
			.from(rawRecords)
			.where(and(eq(rawRecords.provider, provider), eq(rawRecords.kind, kind)))
		return row!.n
	}

	it('pulls every Apollo page, backs off on the 429 and reports the malformed organization', async () => {
		const run = await runIngestion(deps, 'apollo', 'system:test')
		expect(run).toMatchObject({
			status: 'succeeded_with_errors',
			recordsReceived: 432,
			recordsNew: 431,
			recordsUnchanged: 0,
			recordsRejected: 1,
			creditsUsed: '432',
		})
		expect(run.errors).toEqual([expect.objectContaining({ kind: 'company', problem: 'missing name' })])
		expect(sleeps).toEqual([1000])
	})

	it('stores 300 company and 600 contact records across the three providers', async () => {
		await runIngestion(deps, 'factset', 'system:test')
		await runIngestion(deps, 'clay', 'system:test')
		const companies = [
			await rawCount('apollo', 'company'),
			await rawCount('factset', 'company'),
			await rawCount('clay', 'company'),
		]
		const contacts = [
			await rawCount('apollo', 'contact'),
			await rawCount('factset', 'contact'),
			await rawCount('clay', 'contact'),
		]
		expect(companies).toEqual([130, 80, 90])
		expect(contacts).toEqual([301, 107, 192])
	})

	it('records FactSet credits as an exact decimal and the malformed fundamentals row as an error', async () => {
		const [run] = await t.db.select().from(ingestionRuns).where(eq(ingestionRuns.provider, 'factset'))
		expect(run?.creditsUsed).toBe('30.7')
		expect(run?.errors).toEqual([expect.objectContaining({ kind: 'fundamental', problem: 'value is not a number' })])
	})

	it('treats a re-pull as a new run that adds no duplicate records', async () => {
		const before = await t.db.select({ n: count() }).from(rawRecords)
		const run = await runIngestion(deps, 'clay', 'system:test')
		expect(run).toMatchObject({ status: 'succeeded_with_errors', recordsNew: 0, recordsUnchanged: 282 })
		expect(await t.db.select({ n: count() }).from(rawRecords)).toEqual(before)
		expect(await t.db.select({ n: count() }).from(ingestionRuns).where(eq(ingestionRuns.provider, 'clay'))).toEqual([
			{ n: 2 },
		])
	})

	it('marks the run failed when the provider stays down', async () => {
		const failing: IngestDeps = {
			...deps,
			fetch: () => Promise.resolve(new Response('down', { status: 503 })),
			retry: { ...deps.retry, maxAttempts: 2 },
		}
		const run = await runIngestion(failing, 'apollo', 'system:test')
		expect(run.status).toBe('failed')
		expect(run.errors).toEqual([expect.objectContaining({ problem: expect.stringContaining('503') as string })])
	})

	it('initial ingestion only pulls providers that never had a successful run', async () => {
		const before = await t.db.select({ n: count() }).from(ingestionRuns)
		expect(await ingestMissingProviders(deps, 'system:seed')).toEqual([])
		expect(await t.db.select({ n: count() }).from(ingestionRuns)).toEqual(before)
	})
})

describe('initial ingestion on an empty database', () => {
	const t = useTestDb()

	it('pulls all three providers', async () => {
		const world = createFakeWorld()
		const runs = await ingestMissingProviders(
			{
				db: t.db,
				log: createLogger({ level: 'silent' }),
				clock: () => new Date(),
				providerBaseUrl: 'http://fake-world',
				fetch: (input, init) => Promise.resolve(world.app.fetch(new Request(input, init))),
				retry: { sleep: () => Promise.resolve() },
			},
			'system:seed',
		)
		expect(runs.map((run) => [run.provider, run.status])).toEqual([
			['apollo', 'succeeded_with_errors'],
			['factset', 'succeeded_with_errors'],
			['clay', 'succeeded_with_errors'],
		])
	})
})
