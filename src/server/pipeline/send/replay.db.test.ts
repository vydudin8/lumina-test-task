import { isNotNull } from 'drizzle-orm'
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { cards, templates } from '../../db/schema.ts'
import { createStubLlm } from '../../llm/stub.ts'
import { createLogger } from '../../log.ts'
import { seed } from '../../seed/seed.ts'
import { createTestApp, testDeps } from '../../test/app.ts'
import { createCampaignWithLines } from '../../test/campaign.ts'
import { useTestDb } from '../../test/db.ts'
import { TEST_WEBHOOK_SECRET, testWorld } from '../../test/world.ts'
import { approveEligible } from '../campaign/store.ts'
import { runIngestion } from '../ingest/index.ts'
import { launchSend, processQueue } from './store.ts'

const now = new Date('2026-11-20T12:00:00Z')

describe('a webhook that arrives before the submission is recorded', () => {
	const t = useTestDb()

	it('is kept and applied as soon as the card gets its mail id', async () => {
		await seed(t.db, { now })
		for (const provider of ['apollo', 'factset', 'clay'] as const)
			await runIngestion(testDeps(t.db, { clock: () => now }), provider, 'system:test')
		const [a, b] = await t.db.select().from(templates).orderBy(templates.id)
		const deps = { db: t.db, llm: createStubLlm(), log: createLogger({ level: 'silent' }), retry: {}, clock: () => now }
		const { campaign } = await createCampaignWithLines(deps, {
			idempotencyKey: 'replay',
			name: 'Replay',
			topN: 1,
			templateAId: a!.id,
			templateBId: b!.id,
			actor: { id: 'usr_rep_tom', role: 'rep' },
		})
		await approveEligible(deps, { campaignId: campaign.id, actor: { id: 'usr_lead_maya', role: 'lead' } })
		await launchSend(deps, { campaignId: campaign.id, actor: { id: 'usr_lead_maya', role: 'lead' } })

		// The fake world derives the postcard id from the Idempotency-Key, so the event can be sent ahead of the submission.
		const [queued] = await t.db.select().from(cards).where(isNotNull(cards.idempotencyKey))
		const mailId = `psc_${createHash('sha256').update(queued!.idempotencyKey!).digest('hex').slice(0, 16)}`
		const app = createTestApp(t.db, { clock: () => now })
		const body = JSON.stringify({
			event_id: 'evt_early',
			mail_id: mailId,
			status: 'mailed',
			occurred_at: '2026-11-20T12:05:00.000Z',
		})
		const ts = Math.floor(now.getTime() / 1000)
		const signature = `t=${ts},v1=${createHmac('sha256', TEST_WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex')}`
		const early = await app.fetch(
			new Request('http://localhost/webhooks/mail', { method: 'POST', headers: { 'X-Signature': signature }, body }),
		)
		await expect(early.json()).resolves.toEqual({ unknownMailId: true })

		const world = testWorld({ now: () => now })
		await processQueue({
			db: t.db,
			log: createLogger({ level: 'silent' }),
			clock: () => now,
			mail: { baseUrl: 'http://fake', fetch: world.fetch, timeoutMs: 50 },
			retry: { sleep: () => Promise.resolve() },
		})
		const [card] = await t.db.select().from(cards).where(isNotNull(cards.mailId))
		expect(card).toMatchObject({
			mailId,
			status: 'mailed',
			mailedAt: new Date('2026-11-20T12:05:00.000Z'),
		})
	})
})
