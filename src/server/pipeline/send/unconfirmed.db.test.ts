import { and, count, eq, inArray } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { auditEvents, cards, submissionAttempts, templates } from '../../db/schema.ts'
import { createStubLlm } from '../../llm/stub.ts'
import { createLogger } from '../../log.ts'
import { seed } from '../../seed/seed.ts'
import { call, createTestApp, loginAs, testDeps, type FetchApp } from '../../test/app.ts'
import { createCampaignWithLines } from '../../test/campaign.ts'
import { useTestDb } from '../../test/db.ts'
import { testWorld } from '../../test/world.ts'
import { approveEligible } from '../campaign/store.ts'
import { runIngestion } from '../ingest/index.ts'
import { launchSend, processQueue, retryUnconfirmed, startSendWorker, type SendDeps } from './store.ts'

const now = new Date('2026-11-20T12:00:00Z')
const maya = { id: 'usr_lead_maya', role: 'lead' } as const
const tom = { id: 'usr_rep_tom', role: 'rep' } as const
const COOLDOWN = 60_000

describe('unconfirmed cards', () => {
	const t = useTestDb()
	let world: ReturnType<typeof testWorld>
	let send: SendDeps
	let app: FetchApp
	let build: (key: string, topN: number) => Promise<number>

	beforeAll(async () => {
		await seed(t.db, { now })
		for (const provider of ['apollo', 'factset', 'clay'] as const)
			await runIngestion(testDeps(t.db, { clock: () => now }), provider, 'system:test')
		world = testWorld({ now: () => now })
		app = createTestApp(t.db, { clock: () => now })
		send = {
			db: t.db,
			log: createLogger({ level: 'silent' }),
			clock: () => now,
			mail: { baseUrl: 'http://fake', fetch: world.fetch, timeoutMs: 50 },
			// One attempt per card keeps a down provider quick to simulate.
			retry: { maxAttempts: 1, sleep: () => Promise.resolve(), rng: () => 0 },
		}
		const [a, b] = await t.db.select().from(templates).orderBy(templates.id)
		const campaignDeps = { db: t.db, llm: createStubLlm(), log: send.log, retry: {}, clock: () => now }
		// Each test builds a campaign with a larger topN than the one before, so the 90-day rule never blocks it.
		build = async (key, topN) => {
			const { campaign } = await createCampaignWithLines(campaignDeps, {
				idempotencyKey: key,
				name: key,
				topN,
				templateAId: a!.id,
				templateBId: b!.id,
				actor: tom,
			})
			await approveEligible(campaignDeps, { campaignId: campaign.id, actor: maya })
			return campaign.id
		}
	})

	const cardsOf = (campaignId: number) =>
		t.db.select().from(cards).where(eq(cards.campaignId, campaignId)).orderBy(cards.id)

	it('pauses the send worker after three unconfirmed cards, leaves the rest queued untouched, then resumes', async () => {
		const campaignId = await build('breaker', 8)
		await launchSend(send, { campaignId, actor: maya })
		const total = (await cardsOf(campaignId)).filter((card) => card.status === 'queued').length
		expect(total).toBeGreaterThanOrEqual(5)
		await world.control({ mode: 'timeout_always' })

		let reachedCooldown!: () => void
		const paused = new Promise<void>((resolve) => (reachedCooldown = resolve))
		let release!: () => void
		const cooldown = new Promise<void>((resolve) => (release = resolve))
		const sleep = (ms: number) => {
			if (ms !== COOLDOWN) return new Promise<void>((resolve) => setTimeout(resolve, 5))
			reachedCooldown()
			return cooldown
		}
		const worker = startSendWorker(send, { intervalMs: 5, failureThreshold: 3, cooldownMs: COOLDOWN, sleep })
		await paused

		const rows = await cardsOf(campaignId)
		expect(rows.filter((card) => card.status === 'unconfirmed')).toHaveLength(3)
		const stillQueued = rows.filter((card) => card.status === 'queued')
		expect(stillQueued).toHaveLength(total - 3)
		expect(
			await t.db
				.select({ n: count() })
				.from(submissionAttempts)
				.where(
					inArray(
						submissionAttempts.cardId,
						stillQueued.map((card) => card.id),
					),
				),
		).toEqual([{ n: 0 }])

		await world.control({ mode: 'normal' })
		release()
		await vi.waitFor(async () =>
			expect(await t.db.select({ n: count() }).from(cards).where(eq(cards.status, 'queued'))).toEqual([{ n: 0 }]),
		)
		worker.stop()
		await worker.done
		const after = await cardsOf(campaignId)
		expect(after.filter((card) => card.status === 'unconfirmed')).toHaveLength(3)
		expect(after.filter((card) => card.mailId)).toHaveLength(total - 3)
	})

	it('requeues every unconfirmed card of one campaign, lead only, keys unchanged, one postcard per card', async () => {
		const campaignA = await build('bulk-a', 20)
		const campaignB = await build('bulk-b', 35)
		await launchSend(send, { campaignId: campaignA, actor: maya })
		await launchSend(send, { campaignId: campaignB, actor: maya })
		await world.control({ mode: 'timeout_always' })
		await processQueue(send)
		await world.control({ mode: 'normal' })
		const stuck = (await cardsOf(campaignA)).filter((card) => card.status === 'unconfirmed')
		const otherStuck = (await cardsOf(campaignB)).filter((card) => card.status === 'unconfirmed')
		expect(stuck.length).toBeGreaterThan(1)
		expect(otherStuck.length).toBeGreaterThan(0)

		await expect(retryUnconfirmed(send, { campaignId: campaignA, actor: tom })).rejects.toMatchObject({ status: 403 })
		const rep = await loginAs(app, tom.id)
		const path = `/api/campaigns/${campaignA}/retry-unconfirmed`
		expect((await call(app, path, { method: 'POST', cookie: rep })).status).toBe(403)
		const lead = await loginAs(app, maya.id)
		expect((await call(app, '/api/campaigns/abc/retry-unconfirmed', { method: 'POST', cookie: lead })).status).toBe(400)

		const response = await call(app, path, { method: 'POST', cookie: lead })
		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual({ requeued: stuck.length })
		const requeued = await cardsOf(campaignA)
		for (const card of stuck) {
			expect(requeued.find((row) => row.id === card.id)).toMatchObject({
				status: 'queued',
				sendError: null,
				idempotencyKey: card.idempotencyKey,
			})
		}
		expect((await cardsOf(campaignB)).filter((card) => card.status === 'unconfirmed')).toHaveLength(otherStuck.length)

		const retried = () =>
			t.db
				.select()
				.from(auditEvents)
				.where(and(eq(auditEvents.action, 'card.send_retried'), eq(auditEvents.actorId, maya.id)))
		expect(await retried()).toHaveLength(stuck.length)
		expect(await retried()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ result: { idempotencyKey: stuck[0]!.idempotencyKey, bulk: true } }) as unknown,
			]),
		)
		expect(await retryUnconfirmed(send, { campaignId: campaignA, actor: maya })).toEqual({ requeued: 0 })
		expect(await retried()).toHaveLength(stuck.length)

		await processQueue(send)
		const { postcards } = await world.calls()
		const sent = await cardsOf(campaignA)
		for (const card of stuck) {
			const row = sent.find((candidate) => candidate.id === card.id)!
			expect(row.mailId).toBeTruthy()
			expect(postcards.filter((postcard) => postcard.cardId === card.id)).toEqual([
				expect.objectContaining({ id: row.mailId }),
			])
		}
	})
})
