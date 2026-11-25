import { and, count, eq, isNotNull, notInArray } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Manifest } from '../../../../scripts/generate-fixtures.ts'
import { auditEvents, campaigns, cards, companyProfiles, outcomeEvents } from '../../db/schema.ts'
import { readFixture } from '../../seed/fixtures.ts'
import { seedHistory } from '../../seed/history.ts'
import { seed } from '../../seed/seed.ts'
import { testDeps } from '../../test/app.ts'
import { useTestDb } from '../../test/db.ts'
import { runIngestion } from '../ingest/index.ts'
import { companyLabels, mergeCompanies } from '../resolve/store.ts'
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
		const results = await campaignResults(t.db, historicalId)
		for (const variant of ['A', 'B'] as const)
			expect(results.summary.byVariant[variant]).toMatchObject(manifest.historical.byVariant[variant])
		expect(results.summary.outsideWindow).toBe(manifest.historical.outsideWindow)
		expect(
			results.events.filter((event) => event.counted === false).every((event) => event.daysAfterMailing > 30),
		).toBe(true)
		expect(results.summary.tooSmallToConclude).toBe(true)
		// The page lists a company for each event without holding the campaign's cards.
		expect(results.events.every((event) => typeof event.companyName === 'string')).toBe(true)
	})

	it('seeds outcome events once', async () => {
		const before = await t.db.select({ n: count() }).from(outcomeEvents)
		await seedHistory(t.db, new Date(now.getTime() + 86_400_000))
		expect(await t.db.select({ n: count() }).from(outcomeEvents)).toEqual(before)
	})

	it('logs a reply by hand once per Idempotency-Key, audits it and counts it', async () => {
		const results = await campaignResults(t.db, historicalId)
		// A card that has not replied yet: a second reply from the same card would not change the count.
		const replied = new Set(results.events.filter((e) => e.counted && e.kind === 'reply').map((e) => e.cardId))
		const delivered = await t.db
			.select()
			.from(cards)
			.where(and(eq(cards.campaignId, historicalId), eq(cards.variant, 'B'), eq(cards.status, 'delivered')))
		const card = delivered.find((row) => !replied.has(row.id))
		const before = results.summary.byVariant.B.replies
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
		expect((await campaignResults(t.db, historicalId)).summary.byVariant.B.replies).toBe(before + 1)
		expect(await t.db.select({ n: count() }).from(auditEvents).where(eq(auditEvents.action, 'outcome.logged'))).toEqual(
			[{ n: 1 }],
		)
	})

	it('refuses a manual outcome in the future, before the mailing, or for a card that was never mailed', async () => {
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
		await expect(
			logOutcome(
				{ db: t.db, clock: () => now },
				{
					cardId: card!.id,
					kind: 'reply',
					occurredAt: new Date(card!.mailedAt!.getTime() - 1),
					idempotencyKey: 'before-mailing',
					actor: { id: 'usr_rep_tom', role: 'rep' },
				},
			),
		).rejects.toThrow(/before the card was mailed/)
	})
	// Mails the same person again in a second campaign, `days` after the card was.
	async function mailAgain(card: typeof cards.$inferSelect, key: string, days: number) {
		const { id: _id, ...copy } = card
		const [campaign] = await t.db.select().from(campaigns).where(eq(campaigns.id, card.campaignId))
		const { id: _campaignId, ...campaignCopy } = campaign!
		const [later] = await t.db
			.insert(campaigns)
			.values({ ...campaignCopy, idempotencyKey: key })
			.returning()
		const shift = (date: Date | null) => new Date(date!.getTime() + days * 86_400_000)
		await t.db.insert(cards).values({
			...copy,
			campaignId: later!.id,
			idempotencyKey: key,
			mailId: key,
			submittedAt: shift(card.submittedAt),
			mailedAt: shift(card.mailedAt),
			statusChangedAt: shift(card.statusChangedAt),
		})
		return later!.id
	}
	const domainOf = async (companyId: number) => (await companyLabels(t.db, [companyId])).get(companyId)!.domain!

	it('ignores events for companies this campaign never mailed', async () => {
		const [pilot] = await t.db.select().from(campaigns).where(eq(campaigns.idempotencyKey, 'seed:pilot'))
		const [pilotCard] = await t.db.select().from(cards).where(eq(cards.campaignId, pilot!.id)).limit(1)
		const before = await campaignResults(t.db, historicalId)
		const pilotBefore = await campaignResults(t.db, pilot!.id)

		await t.db.insert(outcomeEvents).values({
			kind: 'reply',
			domain: await domainOf(pilotCard!.companyId),
			personKey: pilotCard!.personKey,
			occurredAt: new Date(pilotCard!.mailedAt!.getTime() + 3 * 86_400_000),
			source: 'test',
			idempotencyKey: 'pilot-reply',
			createdBy: 'system:test',
			createdAt: now,
		})
		await t.db.insert(outcomeEvents).values({
			kind: 'meeting',
			domain: 'nobody.example',
			occurredAt: now,
			source: 'test',
			idempotencyKey: 'nobody',
			createdBy: 'system:test',
			createdAt: now,
		})

		expect(await campaignResults(t.db, historicalId)).toEqual(before)
		const pilotAfter = await campaignResults(t.db, pilot!.id)
		expect(pilotAfter.events).toHaveLength(pilotBefore.events.length + 1)
		expect(pilotAfter.summary.byVariant.A.replies).toBe(pilotBefore.summary.byVariant.A.replies + 1)
	})

	it('credits an event to the later mailing of the same person, even in another campaign', async () => {
		const [card] = await t.db
			.select()
			.from(cards)
			.where(and(eq(cards.campaignId, historicalId), eq(cards.status, 'delivered')))
			.limit(1)
		const before = await campaignResults(t.db, historicalId)
		// Day 45 is past the window of the first mailing: a near miss there.
		await t.db.insert(outcomeEvents).values({
			kind: 'reply',
			domain: await domainOf(card!.companyId),
			personKey: card!.personKey,
			occurredAt: new Date(card!.mailedAt!.getTime() + 45 * 86_400_000),
			source: 'test',
			idempotencyKey: 'late-reply',
			createdBy: 'system:test',
			createdAt: now,
		})
		const missed = await campaignResults(t.db, historicalId)
		expect(missed.summary.outsideWindow).toBe(before.summary.outsideWindow + 1)

		// A second mailing on day 40 owns it: 5 days after it, inside its window.
		const laterId = await mailAgain(card!, 'later-campaign', 40)
		expect(await campaignResults(t.db, historicalId)).toEqual(before)
		const later = await campaignResults(t.db, laterId)
		expect(later.summary.byVariant[card!.variant!]).toMatchObject({ sent: 1, replies: 1 })
		expect(later.events).toEqual([expect.objectContaining({ counted: true, daysAfterMailing: 5 })])
	})
	it('still credits a mailed company after a merge, from the domain of either side', async () => {
		const credited = new Set((await campaignResults(t.db, historicalId)).events.map((event) => event.cardId))
		const mailed = await t.db
			.select({ card: cards, profile: companyProfiles })
			.from(cards)
			.innerJoin(companyProfiles, eq(companyProfiles.companyId, cards.companyId))
			.where(isNotNull(cards.mailedAt))
		const target = mailed.find(
			({ card, profile }) =>
				card.campaignId === historicalId &&
				!credited.has(card.id) &&
				profile.sourceCount === 1 &&
				profile.domain &&
				mailed.filter((row) => row.card.companyId === card.companyId).length === 1,
		)!
		const [other] = await t.db
			.select()
			.from(companyProfiles)
			.where(
				and(
					eq(companyProfiles.sourceCount, 2),
					isNotNull(companyProfiles.domain),
					notInArray(
						companyProfiles.companyId,
						mailed.map((row) => row.card.companyId),
					),
				),
			)
			.limit(1)
		const merged = await mergeCompanies(t.db, {
			companyId: target.card.companyId,
			otherCompanyId: other!.companyId,
			reason: 'Same group',
			actor: { id: 'usr_rep_tom', role: 'rep' },
			now,
		})
		// The bigger company keeps its number, so the card's own number is the one merged away.
		expect(merged.companyId).toBe(other!.companyId)

		const visit = (domain: string, idempotencyKey: string) => ({
			kind: 'visit' as const,
			domain,
			occurredAt: new Date(target.card.mailedAt!.getTime() + 3 * 86_400_000),
			source: 'test',
			idempotencyKey,
			createdBy: 'usr_rep_tom',
			createdAt: now,
		})
		await t.db
			.insert(outcomeEvents)
			.values([visit(target.profile.domain!, 'merged-1'), visit(other!.domain!, 'merged-2')])
		const counted = async () =>
			(await campaignResults(t.db, historicalId)).events.filter(
				(event) => event.cardId === target.card.id && event.counted,
			)
		// Both visits count, and the results still name the company.
		expect((await counted()).map((event) => typeof event.companyName)).toEqual(['string', 'string'])
		// A card from before cards kept their recipient's record finds its company through the merge instead.
		await t.db.update(cards).set({ sourceCompanyId: null }).where(eq(cards.id, target.card.id))
		expect(await counted()).toHaveLength(2)
	})
})
