import { and, count, eq, sql } from 'drizzle-orm'
import { createHmac } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { auditEvents, cards, mailEvents, templates } from '../../db/schema.ts'
import { createStubLlm } from '../../llm/stub.ts'
import { createLogger } from '../../log.ts'
import { seed } from '../../seed/seed.ts'
import { createTestApp, testDeps } from '../../test/app.ts'
import { createCampaignWithLines } from '../../test/campaign.ts'
import { useTestDb } from '../../test/db.ts'
import { TEST_WEBHOOK_SECRET, testWorld } from '../../test/world.ts'
import { approveEligible } from '../campaign/store.ts'
import { runIngestion } from '../ingest/index.ts'
import { launchSend, processQueue, reconcileMail, type SendDeps } from './store.ts'

const HOUR = 3_600_000
const staleAfterMs = HOUR
const start = new Date('2026-11-20T12:00:00Z')

describe('mail reconciliation', () => {
	const t = useTestDb()
	let current = start
	let outage = false
	let gets: string[] = []
	let send: SendDeps
	let campaignId: number

	// Webhooks never arrive: the provider's redeliveries all hit a 500, as if we were down.
	const world = testWorld({ now: () => current, deliver: () => Promise.resolve(new Response('down', { status: 500 })) })
	const reconcile = (batch = 20) => reconcileMail(send, { batch, staleAfterMs })
	const cardsOf = () => t.db.select().from(cards).where(eq(cards.campaignId, campaignId)).orderBy(cards.id)
	const reconciledAudits = () => t.db.select().from(auditEvents).where(eq(auditEvents.action, 'card.status_reconciled'))

	beforeAll(async () => {
		await seed(t.db, { now: start })
		for (const provider of ['apollo', 'factset', 'clay'] as const)
			await runIngestion(testDeps(t.db, { clock: () => start }), provider, 'system:test')
		send = {
			db: t.db,
			log: createLogger({ level: 'silent' }),
			clock: () => current,
			mail: {
				baseUrl: 'http://fake',
				timeoutMs: 50,
				fetch: (input, init) => {
					// Submissions are POSTs; only the reconciler issues plain GETs.
					if (!init?.method) gets.push(String(input))
					if (outage) return Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
					return world.fetch(input, init)
				},
			},
			retry: { sleep: () => Promise.resolve(), rng: () => 0 },
		}
		const [a, b] = await t.db.select().from(templates).orderBy(templates.id)
		const deps = { db: t.db, llm: createStubLlm(), log: send.log, retry: {}, clock: () => start }
		const created = await createCampaignWithLines(deps, {
			idempotencyKey: 'reconcile',
			name: 'Reconcile',
			topN: 6,
			templateAId: a!.id,
			templateBId: b!.id,
			actor: { id: 'usr_rep_tom', role: 'rep' },
		})
		campaignId = created.campaign.id
		await approveEligible(deps, { campaignId, actor: { id: 'usr_lead_maya', role: 'lead' } })
		await launchSend(deps, { campaignId, actor: { id: 'usr_lead_maya', role: 'lead' } })
		await processQueue(send)
		await world.idle()
	})

	it('leaves a recently changed card alone', async () => {
		expect((await cardsOf()).filter((card) => card.status === 'submitted').length).toBeGreaterThanOrEqual(4)
		expect(await t.db.select({ n: count() }).from(mailEvents).where(eq(mailEvents.source, 'webhook'))).toEqual([
			{ n: 0 },
		])
		current = new Date(start.getTime() + HOUR - 1000)
		expect(await reconcile()).toMatchObject({ polled: 0 })
		expect(gets).toEqual([])
	})

	it('polls at most one batch per tick', async () => {
		current = new Date(start.getTime() + HOUR + 1000)
		expect(await reconcile(2)).toMatchObject({ polled: 2, moved: 2 })
		expect(gets).toHaveLength(2)
		expect((await cardsOf()).filter((card) => card.status === 'delivered')).toHaveLength(2)
	})

	it('moves stale cards to delivered and audits each change; final cards are never polled again', async () => {
		const due = (await cardsOf()).filter((card) => card.status === 'submitted')
		gets = []
		expect(await reconcile()).toMatchObject({ polled: due.length, moved: due.length, stopped: false })
		expect(gets).toHaveLength(due.length)

		const rows = (await cardsOf()).filter((card) => card.mailId)
		for (const card of rows) {
			expect(card).toMatchObject({ status: 'delivered', reconciledAt: current })
			expect(card.mailedAt).not.toBeNull()
		}
		const audits = await reconciledAudits()
		expect(audits).toHaveLength(rows.length)
		expect(audits[0]).toMatchObject({
			actorId: 'system:mail-reconciler',
			before: { status: 'submitted' },
			after: { status: 'delivered' },
		})
		expect(await t.db.select({ n: count() }).from(mailEvents).where(eq(mailEvents.source, 'reconcile'))).toEqual([
			{ n: rows.length * 4 },
		])

		gets = []
		current = new Date(current.getTime() + 2 * HOUR)
		expect(await reconcile()).toMatchObject({ polled: 0 })
		expect(gets).toEqual([])
	})

	it('treats a late webhook for an event reconciliation already recorded as a duplicate', async () => {
		const [card] = await cardsOf()
		const body = JSON.stringify({
			event_id: `evt_${card!.mailId}_delivered`,
			mail_id: card!.mailId,
			status: 'delivered',
			occurred_at: start.toISOString(),
		})
		const ts = Math.floor(current.getTime() / 1000)
		const signature = `t=${ts},v1=${createHmac('sha256', TEST_WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex')}`
		const app = createTestApp(t.db, { clock: () => current })
		const late = await app.fetch(
			new Request('http://localhost/webhooks/mail', { method: 'POST', headers: { 'X-Signature': signature }, body }),
		)
		await expect(late.json()).resolves.toEqual({ duplicate: true })
	})

	it('marks a postcard the provider has never heard of as reconciled, and asks again only after the stale window', async () => {
		const [card] = await cardsOf()
		const old = new Date(current.getTime() - 2 * HOUR)
		await t.db.execute(
			sql`UPDATE cards SET status = 'mailed', mail_id = 'psc_gone', status_changed_at = ${old}, reconciled_at = NULL WHERE id = ${card!.id}`,
		)
		gets = []
		const audited = (await reconciledAudits()).length
		expect(await reconcile()).toMatchObject({ polled: 1, moved: 0, stopped: false })
		expect(gets).toHaveLength(1)
		expect((await t.db.select().from(cards).where(eq(cards.id, card!.id)))[0]).toMatchObject({
			status: 'mailed',
			reconciledAt: current,
		})
		expect(await reconciledAudits()).toHaveLength(audited)

		gets = []
		await reconcile()
		expect(gets).toEqual([])
		current = new Date(current.getTime() + HOUR + 1000)
		await reconcile()
		expect(gets).toHaveLength(1)
	})

	it('stops the tick without throwing when the provider does not answer, and leaves the cards due', async () => {
		const stale = new Date(current.getTime() - 2 * HOUR)
		await t.db.execute(
			sql`UPDATE cards SET status = 'mailed', mail_id = 'psc_x' || id, status_changed_at = ${stale}, reconciled_at = NULL WHERE campaign_id = ${campaignId} AND mail_id IS NOT NULL`,
		)
		outage = true
		gets = []
		const summary = await reconcile()
		outage = false
		expect(summary).toMatchObject({ polled: 0, stopped: true })
		// Three attempts at the first card, then nothing for the rest.
		expect(gets).toHaveLength(3)
		const due = await t.db
			.select({ n: count() })
			.from(cards)
			.where(and(eq(cards.campaignId, campaignId), eq(cards.status, 'mailed'), sql`${cards.reconciledAt} IS NULL`))
		expect(due[0]!.n).toBeGreaterThan(1)
	})
})
