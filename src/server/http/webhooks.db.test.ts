import { eq, isNotNull } from 'drizzle-orm'
import { createHmac } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { cards, mailEvents, templates } from '../db/schema.ts'
import { createStubLlm } from '../llm/stub.ts'
import { createLogger } from '../log.ts'
import { approveEligible } from '../pipeline/campaign/store.ts'
import { runIngestion } from '../pipeline/ingest/index.ts'
import { launchSend, processQueue } from '../pipeline/send/store.ts'
import { seed } from '../seed/seed.ts'
import { createTestApp, testDeps, type FetchApp } from '../test/app.ts'
import { createCampaignWithLines } from '../test/campaign.ts'
import { useTestDb } from '../test/db.ts'
import { TEST_WEBHOOK_SECRET, testWorld } from '../test/world.ts'

const now = new Date('2026-11-20T12:00:00Z')

describe('mail webhooks', () => {
	const t = useTestDb()
	let app: FetchApp
	let mailId: string
	let cardId: number

	beforeAll(async () => {
		await seed(t.db, { now })
		for (const provider of ['apollo', 'factset', 'clay'] as const)
			await runIngestion(testDeps(t.db, { clock: () => now }), provider, 'system:test')
		app = createTestApp(t.db, { clock: () => now })
		const [a, b] = await t.db.select().from(templates).orderBy(templates.id)
		const deps = { db: t.db, llm: createStubLlm(), log: createLogger({ level: 'silent' }), retry: {}, clock: () => now }
		const { campaign } = await createCampaignWithLines(deps, {
			idempotencyKey: 'webhooks',
			name: 'Webhooks',
			topN: 1,
			templateAId: a!.id,
			templateBId: b!.id,
			actor: { id: 'usr_rep_tom', role: 'rep' },
		})
		await approveEligible(deps, { campaignId: campaign.id, actor: { id: 'usr_lead_maya', role: 'lead' } })
		await launchSend(deps, { campaignId: campaign.id, actor: { id: 'usr_lead_maya', role: 'lead' } })
		const world = testWorld({ now: () => now })
		await processQueue({
			db: t.db,
			log: createLogger({ level: 'silent' }),
			clock: () => now,
			mail: { baseUrl: 'http://fake', fetch: world.fetch, timeoutMs: 50 },
			retry: { sleep: () => Promise.resolve() },
		})
		const [card] = await t.db.select().from(cards).where(isNotNull(cards.mailId))
		mailId = card!.mailId!
		cardId = card!.id
	})

	const event = (status: string, overrides: Record<string, string> = {}) => ({
		event_id: `evt_${status}`,
		mail_id: mailId,
		status,
		occurred_at: new Date(now.getTime() + 60_000).toISOString(),
		...overrides,
	})
	const send = (payload: unknown, { secret = TEST_WEBHOOK_SECRET, at = now } = {}) => {
		const body = JSON.stringify(payload)
		const t = Math.floor(at.getTime() / 1000)
		const signature = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
		return app.fetch(
			new Request('http://localhost/webhooks/mail', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Signature': signature },
				body,
			}),
		)
	}
	const card = async () => (await t.db.select().from(cards).where(eq(cards.id, cardId)))[0]!

	it('rejects a bad signature, keeps the payload for the record and changes nothing', async () => {
		const response = await send(event('delivered', { event_id: 'evt_forged' }), { secret: 'wrong-secret-0123456789' })
		expect(response.status).toBe(401)
		expect((await card()).status).toBe('submitted')
		const [stored] = await t.db.select().from(mailEvents).where(eq(mailEvents.signatureOk, false))
		expect(stored).toMatchObject({ providerEventId: null, payload: { event_id: 'evt_forged' } })
	})

	it('rejects a correctly signed but stale event', async () => {
		const response = await send(event('delivered', { event_id: 'evt_old' }), {
			at: new Date(now.getTime() - 10 * 60_000),
		})
		expect(response.status).toBe(401)
	})

	it('stores a duplicate event once', async () => {
		expect(await (await send(event('printed'))).json()).toEqual({ applied: true })
		expect(await (await send(event('printed'))).json()).toEqual({ duplicate: true })
		expect(await t.db.select().from(mailEvents).where(eq(mailEvents.providerEventId, 'evt_printed'))).toHaveLength(1)
		expect((await card()).status).toBe('printed')
	})

	it('only moves forward when events arrive out of order, but still records when it was mailed', async () => {
		await send(event('delivered'))
		expect((await card()).status).toBe('delivered')
		await send(event('printed', { event_id: 'evt_printed_late' }))
		expect((await card()).status).toBe('delivered')
		await send(event('mailed', { occurred_at: '2026-11-21T09:00:00.000Z' }))
		expect(await card()).toMatchObject({ status: 'delivered', mailedAt: new Date('2026-11-21T09:00:00.000Z') })
	})

	it('refuses an oversized body before reading it', async () => {
		const response = await send({ ...event('mailed', { event_id: 'evt_big' }), padding: 'x'.repeat(100_000) })
		expect(response.status).toBe(413)
	})

	it('accepts and stores an event for an unknown mail id', async () => {
		const response = await send(event('mailed', { event_id: 'evt_stranger', mail_id: 'psc_unknown' }))
		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual({ unknownMailId: true })
		expect(await t.db.select().from(mailEvents).where(eq(mailEvents.mailId, 'psc_unknown'))).toHaveLength(1)
	})

	it('stores a duplicate event once when both copies arrive at the same moment', async () => {
		const copy = event('returned', { event_id: 'evt_returned_race' })
		const responses = await Promise.all([send(copy), send(copy)])
		const answers = await Promise.all(responses.map((response) => response.json() as Promise<object>))
		expect(answers).toEqual(expect.arrayContaining([{ applied: true }, { duplicate: true }]))
		expect(answers).toHaveLength(2)
		expect(
			await t.db.select().from(mailEvents).where(eq(mailEvents.providerEventId, 'evt_returned_race')),
		).toHaveLength(1)
	})
})
