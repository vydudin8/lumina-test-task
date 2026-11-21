import { and, count, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Manifest } from '../../../../scripts/generate-fixtures.ts'
import { auditEvents, campaigns, cards, outcomeEvents } from '../../db/schema.ts'
import { readFixture } from '../../seed/fixtures.ts'
import { seedHistory } from '../../seed/history.ts'
import { seed } from '../../seed/seed.ts'
import { testDeps } from '../../test/app.ts'
import { useTestDb } from '../../test/db.ts'
import { runIngestion } from '../ingest/index.ts'
import { campaignResults, logOutcome } from './store.ts'

const manifest = readFixture<Manifest>('manifest.json')
const now = new Date(`${manifest.anchor}T12:00:00Z`)

describe('results', () => {
	const t = useTestDb()
	let historicalId: number

	beforeAll(async () => {
		await seed(t.db, { now })
		for (const provider of ['apollo', 'factset', 'clay'] as const)
			await runIngestion(testDeps(t.db, { clock: () => now }), provider, 'system:test')
		await seedHistory(t.db, now)
		const [historical] = await t.db.select().from(campaigns).where(eq(campaigns.idempotencyKey, 'seed:historical'))
		historicalId = historical!.id
	})

	it('reproduces the historical A/B results, leaving the day-35 events out', async () => {
		const results = await campaignResults(t.db, historicalId, now)
		for (const variant of ['A', 'B'] as const)
			expect(results.summary.byVariant[variant]).toMatchObject(manifest.historical.byVariant[variant])
		expect(results.summary.outsideWindow).toBe(manifest.historical.outsideWindow)
		expect(
			results.events.filter((event) => event.counted === false).every((event) => event.daysAfterMailing > 30),
		).toBe(true)
		expect(results.summary.tooSmallToConclude).toBe(true)
	})

	it('seeds outcome events once', async () => {
		const before = await t.db.select({ n: count() }).from(outcomeEvents)
		await seedHistory(t.db, new Date(now.getTime() + 86_400_000))
		expect(await t.db.select({ n: count() }).from(outcomeEvents)).toEqual(before)
	})

	it('logs a reply by hand once per Idempotency-Key, audits it and counts it', async () => {
		const [card] = await t.db
			.select()
			.from(cards)
			.where(and(eq(cards.campaignId, historicalId), eq(cards.variant, 'B'), eq(cards.status, 'delivered')))
			.limit(1)
		const before = (await campaignResults(t.db, historicalId, now)).summary.byVariant.B.replies
		const input = {
			cardId: card!.id,
			kind: 'reply' as const,
			occurredAt: new Date(card!.mailedAt!.getTime() + 10 * 86_400_000),
			note: 'Called back',
			idempotencyKey: 'reply-1',
			actor: { id: 'usr_rep_tom', role: 'rep' as const },
		}

		expect(await logOutcome({ db: t.db, clock: () => now }, input)).toMatchObject({ created: true })
		expect(await logOutcome({ db: t.db, clock: () => now }, input)).toMatchObject({ created: false })
		expect((await campaignResults(t.db, historicalId, now)).summary.byVariant.B.replies).toBe(before + 1)
		expect(await t.db.select({ n: count() }).from(auditEvents).where(eq(auditEvents.action, 'outcome.logged'))).toEqual(
			[{ n: 1 }],
		)
	})

	it('refuses a manual outcome in the future or for a card that was never mailed', async () => {
		const [card, unmailed] = await t.db.select().from(cards).where(eq(cards.campaignId, historicalId)).limit(2)
		await t.db.update(cards).set({ mailedAt: null }).where(eq(cards.id, unmailed!.id))
		await expect(
			logOutcome(
				{ db: t.db, clock: () => now },
				{
					cardId: unmailed!.id,
					kind: 'reply',
					occurredAt: now,
					idempotencyKey: 'unmailed',
					actor: { id: 'usr_rep_tom', role: 'rep' },
				},
			),
		).rejects.toMatchObject({ status: 409 })
		await expect(
			logOutcome(
				{ db: t.db, clock: () => now },
				{
					cardId: card!.id,
					kind: 'meeting',
					occurredAt: new Date(now.getTime() + 86_400_000),
					idempotencyKey: 'future',
					actor: { id: 'usr_rep_tom', role: 'rep' },
				},
			),
		).rejects.toThrow(/future/)
	})
})
