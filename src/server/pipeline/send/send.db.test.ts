import { and, count, eq, isNotNull, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { auditEvents, campaigns, cards, submissionAttempts, templates } from '../../db/schema.ts'
import { createStubLlm } from '../../llm/stub.ts'
import { createLogger } from '../../log.ts'
import { suppressionReason } from '../../policy/suppression.ts'
import { seedHistory } from '../../seed/history.ts'
import { seed } from '../../seed/seed.ts'
import { createTestApp, testDeps } from '../../test/app.ts'
import { createCampaignWithLines } from '../../test/campaign.ts'
import { useTestDb } from '../../test/db.ts'
import { testWorld } from '../../test/world.ts'
import { approveEligible, loadPersonSuppression, loadSuppressionState } from '../campaign/store.ts'
import { runIngestion } from '../ingest/index.ts'
import { addOptOut, launchSend, processOne, processQueue, retrySend, type SendDeps } from './store.ts'

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
		const [a, b] = await t.db.select().from(templates).orderBy(templates.id)
		const campaignDeps = {
			db: t.db,
			llm: createStubLlm(),
			log: createLogger({ level: 'silent' }),
			retry: {},
			clock: () => now,
		}
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
		t.db.select().from(cards).where(eq(cards.campaignId, campaignId)).orderBy(cards.rank)

	it('lets only a lead launch, in the API layer and in the database', async () => {
		const campaignId = await build('launch-rules', 3)
		await expect(launchSend(send, { campaignId, actor: tom })).rejects.toMatchObject({ status: 403 })
		const forged = t.db.execute(
			sql`UPDATE campaigns SET launched_at = now(), launched_by = 'usr_rep_tom', launched_by_role = 'rep' WHERE id = ${campaignId}`,
		)
		await expect(forged).rejects.toMatchObject({ cause: { constraint: 'campaigns_launcher_is_lead' } })
		const roleless = t.db.execute(
			sql`UPDATE campaigns SET launched_at = now(), launched_by = 'usr_rep_tom' WHERE id = ${campaignId}`,
		)
		await expect(roleless).rejects.toMatchObject({ cause: { constraint: 'campaigns_launcher_has_role' } })
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
		expect(campaign).toMatchObject({ launchedBy: 'usr_lead_maya', launchedByRole: 'lead' })
		expect(campaign).not.toHaveProperty('status')
	})

	it('queues the approved cards once when two launches race', async () => {
		const campaignId = await build('launch-race', 3)
		const approved = (await cardsOf(campaignId)).filter((card) => card.status === 'approved').length
		expect(approved).toBeGreaterThan(0)
		const results = await Promise.all([
			launchSend(send, { campaignId, actor: maya }),
			launchSend(send, { campaignId, actor: maya }),
		])
		expect(results.map((result) => result.queued).sort((x, y) => x - y)).toEqual([0, approved])
		const events = await t.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'campaign.send_launched'), eq(auditEvents.entityId, String(campaignId))))
		expect(events).toHaveLength(1)
	})

	it('blocks a card at send when the person opted out after approval; the mail API never hears of it', async () => {
		await processQueue(send)
		const campaignId = await build('opt-out-late', 10)
		const [target] = (await cardsOf(campaignId)).filter((card) => card.status === 'approved')
		await addOptOut(send, { email: target!.personKey!.toUpperCase(), source: 'phone call', actor: tom })
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

	it('marks a card unconfirmed when every attempt timed out, holds the person back, and retries with the same key', async () => {
		await processQueue(send)
		const campaignId = await build('unconfirmed', 30)
		await launchSend(send, { campaignId, actor: maya })
		await world.control({ mode: 'timeout_always' })
		await processQueue(send)
		await world.control({ mode: 'normal' })

		const [stuck] = (await cardsOf(campaignId)).filter((row) => row.status === 'unconfirmed')
		expect(stuck).toMatchObject({ mailId: null, submittedAt: null })
		const attempts = await t.db.select().from(submissionAttempts).where(eq(submissionAttempts.cardId, stuck!.id))
		expect(attempts.map((attempt) => attempt.outcome)).toEqual(Array(6).fill('timeout'))
		expect(suppressionReason(stuck!.personKey!, await loadSuppressionState(t.db), now)).toBe('mailed_90d')

		await expect(retrySend(send, { cardId: stuck!.id, actor: tom })).rejects.toMatchObject({ status: 403 })
		expect(await retrySend(send, { cardId: stuck!.id, actor: maya })).toMatchObject({ changed: true })
		expect(await retrySend(send, { cardId: stuck!.id, actor: maya })).toMatchObject({ changed: false })
		await processQueue(send)

		const [sent] = await t.db.select().from(cards).where(eq(cards.id, stuck!.id))
		expect(sent?.mailId).toBeTruthy()
		expect((await world.calls()).postcards.filter((postcard) => postcard.cardId === stuck!.id)).toEqual([
			expect.objectContaining({ id: sent!.mailId }),
		])
		expect(
			await t.db
				.select({ n: count() })
				.from(auditEvents)
				.where(and(eq(auditEvents.action, 'card.send_retried'), eq(auditEvents.entityId, String(stuck!.id)))),
		).toEqual([{ n: 1 }])
	})

	it('survives a worker crash after the printer accepted: the card is sent again with its key and gets the same postcard', async () => {
		await processQueue(send)
		await world.idle()
		const campaignId = await build('crash', 36)
		await launchSend(send, { campaignId, actor: maya })
		const [target] = (await cardsOf(campaignId)).filter((card) => card.status === 'queued').sort((a, b) => a.id - b.id)

		// Everything in the worker's transaction runs, the printer answers 201, then the process dies before COMMIT.
		const crashing = Object.create(t.db, {
			transaction: {
				value: (work: (tx: unknown) => Promise<unknown>) =>
					t.db.transaction(async (tx) => {
						await work(tx)
						throw new Error('worker crashed before commit')
					}),
			},
		}) as typeof t.db
		await expect(processOne({ ...send, db: crashing })).rejects.toThrow('worker crashed before commit')

		const [lost] = await t.db.select().from(cards).where(eq(cards.id, target!.id))
		expect(lost).toMatchObject({ status: 'queued', mailId: null, idempotencyKey: target!.idempotencyKey })
		expect(await t.db.select().from(submissionAttempts).where(eq(submissionAttempts.cardId, target!.id))).toEqual([])
		const printed = (await world.calls()).postcards.filter((postcard) => postcard.cardId === target!.id)
		expect(printed).toHaveLength(1)
		// The printer's webhooks for that postcard reach us while no card knows its mail id; they are kept.
		await world.idle()

		await processQueue(send)
		await world.idle()
		const [sent] = await t.db.select().from(cards).where(eq(cards.id, target!.id))
		expect(sent).toMatchObject({ mailId: printed[0]!.id, status: 'delivered' })
		const { postcards, submissions } = await world.calls()
		expect(postcards.filter((postcard) => postcard.cardId === target!.id)).toHaveLength(1)
		expect(submissions.filter((call) => call.cardId === target!.id)).toHaveLength(2)
		const attempts = await t.db.select().from(submissionAttempts).where(eq(submissionAttempts.cardId, target!.id))
		// 200, not 201: the printer replayed the postcard it already had for this key.
		expect(attempts.map((attempt) => [attempt.n, attempt.outcome, attempt.httpStatus])).toEqual([[1, 'ok', 200]])
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

	it('takes a card that breaks on our side out of the queue, so the cards behind it still go', async () => {
		await processQueue(send)
		await world.idle()
		const campaignId = await build('broken', 44)
		await launchSend(send, { campaignId, actor: maya })
		const queued = (await cardsOf(campaignId)).filter((card) => card.status === 'queued').sort((a, b) => a.id - b.id)
		expect(queued.length).toBeGreaterThan(1)
		const broken = queued[0]!
		// Another card already holds the id the printer will give this one, as after a fake world that numbered from 1 again.
		const taken = `psc_${createHash('sha256').update(broken.idempotencyKey!).digest('hex').slice(0, 16)}`
		const [holder] = await t.db
			.update(cards)
			.set({ mailId: taken })
			.where(sql`${cards.id} = (SELECT id FROM cards WHERE status = 'blocked' AND mail_id IS NULL LIMIT 1)`)
			.returning({ id: cards.id })

		const summary = await processQueue(send)
		expect(summary.unconfirmed).toBe(1)
		expect(summary.submitted).toBe(queued.length - 1)
		const [stuck] = await t.db.select().from(cards).where(eq(cards.id, broken.id))
		// The constraint, not the query: its text would carry the person's name and address.
		expect(stuck).toMatchObject({ status: 'unconfirmed', mailId: null })
		expect(stuck!.sendError).toMatch(/^\w+ 23505 cards_mailId_unique$/)
		expect(
			await t.db
				.select({ reason: auditEvents.reason })
				.from(auditEvents)
				.where(and(eq(auditEvents.action, 'card.send_unconfirmed'), eq(auditEvents.entityId, String(broken.id)))),
		).toEqual([{ reason: 'internal_error' }])
		// Asked once, not again on every turn of the worker.
		expect((await world.calls()).submissions.filter((call) => call.cardId === broken.id)).toHaveLength(1)

		// Once the cause is gone, a lead's retry gets the postcard the printer already made for this key.
		await t.db.update(cards).set({ mailId: null }).where(eq(cards.id, holder!.id))
		await retrySend(send, { cardId: broken.id, actor: maya })
		await processQueue(send)
		await world.idle()
		const [sent] = await t.db.select().from(cards).where(eq(cards.id, broken.id))
		expect(sent).toMatchObject({ mailId: taken, status: 'delivered' })
		expect((await world.calls()).postcards.filter((postcard) => postcard.cardId === broken.id)).toHaveLength(1)
	})

	it('checks one person at send exactly as the full suppression state would', async () => {
		const everyone = await loadSuppressionState(t.db)
		const people = await t.db.selectDistinct({ key: cards.personKey }).from(cards).where(isNotNull(cards.personKey))
		const seen = new Set<string | null>()
		for (const { key } of people) {
			const expected = suppressionReason(key!, everyone, now)
			expect(suppressionReason(key!, await loadPersonSuppression(t.db, key!), now)).toBe(expected)
			seen.add(expected)
		}
		// The history above has people of every kind, so the comparison covers each reason.
		expect(seen).toEqual(new Set(['opt_out', 'mailed_90d', null]))
	})
})
