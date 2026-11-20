import { and, count, eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { auditEvents, campaigns, cards, submissionAttempts, templates } from '../../db/schema.ts'
import { createStubLlm } from '../../llm/stub.ts'
import { createLogger } from '../../log.ts'
import { seedHistory } from '../../seed/history.ts'
import { seed } from '../../seed/seed.ts'
import { createTestApp, testDeps } from '../../test/app.ts'
import { useTestDb } from '../../test/db.ts'
import { testWorld } from '../../test/world.ts'
import { approveEligible, createCampaign } from '../campaign/store.ts'
import { runIngestion } from '../ingest/index.ts'
import { addOptOut, launchSend, processQueue, type SendDeps } from './store.ts'

const now = new Date('2026-11-20T12:00:00Z')
const maya = { id: 'usr_lead_maya', role: 'lead' } as const
const tom = { id: 'usr_rep_tom', role: 'rep' } as const

describe('send pipeline', () => {
	const t = useTestDb()
	let world: ReturnType<typeof testWorld>
	let send: SendDeps
	let build: (key: string, topN: number) => Promise<number>

	beforeAll(async () => {
		await seed(t.db, { now })
		const ingest = testDeps(t.db, { clock: () => now })
		for (const provider of ['apollo', 'factset', 'clay'] as const) await runIngestion(ingest, provider, 'system:test')
		await seedHistory(t.db, now)

		const app = createTestApp(t.db, { clock: () => now })
		world = testWorld({ now: () => now, deliver: (request) => Promise.resolve(app.fetch(request)) })
		send = {
			db: t.db,
			log: createLogger({ level: 'silent' }),
			clock: () => now,
			mail: { baseUrl: 'http://fake', fetch: world.fetch, timeoutMs: 50 },
			retry: { sleep: () => Promise.resolve(), rng: () => 0 },
		}
		const [a, b] = await t.db.select().from(templates).orderBy(templates.variant)
		const campaignDeps = {
			db: t.db,
			llm: createStubLlm(),
			log: createLogger({ level: 'silent' }),
			retry: {},
			clock: () => now,
		}
		build = async (key, topN) => {
			const { campaign } = await createCampaign(campaignDeps, {
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
		t.db.select().from(cards).where(eq(cards.campaignId, campaignId)).orderBy(cards.rank)

	it('lets only a lead launch, in the API layer and in the database', async () => {
		const campaignId = await build('launch-rules', 3)
		await expect(launchSend(send, { campaignId, actor: tom })).rejects.toMatchObject({ status: 403 })
		const forged = t.db.execute(
			sql`UPDATE campaigns SET status = 'sending', launched_at = now(), launched_by = 'usr_rep_tom', launched_by_role = 'rep' WHERE id = ${campaignId}`,
		)
		await expect(forged).rejects.toMatchObject({ cause: { constraint: 'campaigns_launcher_is_lead' } })
	})

	it('queues the approved cards once; a second launch changes nothing and audits nothing', async () => {
		const campaignId = await build('launch-once', 3)
		const approved = (await cardsOf(campaignId)).filter((card) => card.status === 'approved').length
		expect(await launchSend(send, { campaignId, actor: maya })).toMatchObject({ queued: approved })
		expect(await launchSend(send, { campaignId, actor: maya })).toMatchObject({ queued: 0 })
		const events = await t.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'campaign.send_launched'), eq(auditEvents.entityId, String(campaignId))))
		expect(events).toEqual([expect.objectContaining({ actorId: 'usr_lead_maya', result: { cards_queued: approved } })])
		const [campaign] = await t.db.select().from(campaigns).where(eq(campaigns.id, campaignId))
		expect(campaign).toMatchObject({ status: 'sending', launchedBy: 'usr_lead_maya', launchedByRole: 'lead' })
	})

	it('blocks a card at send when the person opted out after approval; the mail API never hears of it', async () => {
		await processQueue(send)
		const campaignId = await build('opt-out-late', 10)
		const [target] = (await cardsOf(campaignId)).filter((card) => card.status === 'approved')
		await addOptOut(send, { email: target!.personKey.toUpperCase(), source: 'phone call', actor: tom })
		await launchSend(send, { campaignId, actor: maya })
		await processQueue(send)
		const [card] = await t.db.select().from(cards).where(eq(cards.id, target!.id))
		expect(card).toMatchObject({ status: 'blocked_at_send', blockReason: 'suppressed:opt_out', mailId: null })
		expect((await world.calls()).submissions.filter((call) => call.cardId === target!.id)).toHaveLength(0)
		expect((await cardsOf(campaignId)).filter((row) => row.mailId).length).toBeGreaterThan(0)
		const [event] = await t.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'card.blocked_at_send'), eq(auditEvents.entityId, String(target!.id))))
		expect(event).toMatchObject({ actorId: 'system:send-worker', decision: 'blocked', reason: 'suppressed:opt_out' })
	})

	it('survives a timeout: the retry reuses the Idempotency-Key, so there is one postcard and one mail_id', async () => {
		await processQueue(send)
		const campaignId = await build('timeout', 15)
		await launchSend(send, { campaignId, actor: maya })
		await world.control({ mode: 'timeout_once' })
		await processQueue(send)

		const [first] = (await cardsOf(campaignId)).filter((card) => card.mailId)
		expect(first).toMatchObject({ status: expect.stringMatching(/submitted|printed|mailed|delivered/) as string })
		const { postcards, submissions } = await world.calls()
		expect(postcards.filter((postcard) => postcard.cardId === first!.id)).toEqual([
			expect.objectContaining({ id: first!.mailId }),
		])
		expect(submissions.filter((call) => call.cardId === first!.id)).toHaveLength(2)
		const attempts = await t.db
			.select()
			.from(submissionAttempts)
			.where(eq(submissionAttempts.cardId, first!.id))
			.orderBy(submissionAttempts.n)
		expect(attempts.map((attempt) => [attempt.n, attempt.outcome])).toEqual([
			[1, 'timeout'],
			[2, 'ok'],
		])
		const [audited] = await t.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'card.submitted'), eq(auditEvents.entityId, String(first!.id))))
		expect(audited?.result).toMatchObject({ mail_id: first!.mailId, attempts: 2 })
	})

	it('retries a 500 and gives up at once on a 4xx, leaving the card failed for a person to decide', async () => {
		await processQueue(send)
		const campaignId = await build('errors', 20)
		const [broken, fine] = (await cardsOf(campaignId)).filter((row) => row.status === 'approved')
		await t.db.execute(
			sql`UPDATE cards SET recipient = jsonb_set(recipient, '{fullName}', '""') WHERE id = ${broken!.id}`,
		)
		await launchSend(send, { campaignId, actor: maya })
		await world.control({ mode: 'error_500_once' })
		await processQueue(send)

		const [failed] = await t.db.select().from(cards).where(eq(cards.id, broken!.id))
		expect(failed).toMatchObject({
			status: 'failed',
			mailId: null,
			sendError: expect.stringContaining('422') as string,
		})
		const attempts = await t.db
			.select()
			.from(submissionAttempts)
			.where(eq(submissionAttempts.cardId, broken!.id))
			.orderBy(submissionAttempts.n)
		expect(attempts.map((attempt) => [attempt.outcome, attempt.httpStatus])).toEqual([
			['error', 500],
			['error', 422],
		])
		expect(attempts[0]?.delayMs).not.toBeNull()
		const [event] = await t.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'card.failed'), eq(auditEvents.entityId, String(broken!.id))))
		expect(event).toMatchObject({ actorId: 'system:send-worker', result: { attempts: 2 } })
		expect((await t.db.select().from(cards).where(eq(cards.id, fine!.id)))[0]?.mailId).toBeTruthy()
	})

	it('moves cards forward from the signed webhooks until they are delivered', async () => {
		await processQueue(send)
		await world.idle()
		const rows = await t.db
			.select()
			.from(cards)
			.where(sql`${cards.mailId} IS NOT NULL AND ${cards.idempotencyKey} NOT LIKE 'seed:%'`)
		expect(rows.length).toBeGreaterThan(0)
		for (const card of rows) {
			expect(card.status).toBe('delivered')
			expect(card.mailedAt).not.toBeNull()
		}
		expect(await t.db.select({ n: count() }).from(cards).where(eq(cards.status, 'queued'))).toEqual([{ n: 0 }])
	})
})
