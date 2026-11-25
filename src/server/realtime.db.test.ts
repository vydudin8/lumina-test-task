import { and, eq, isNotNull, notInArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Executor } from './db/client.ts'
import { campaigns, cards, companyProfiles, outcomeEvents } from './db/schema.ts'
import { createLogger } from './log.ts'
import { runIngestion } from './pipeline/ingest/index.ts'
import { mergeCompanies } from './pipeline/resolve/store.ts'
import { createHub, type PgHub } from './realtime.ts'
import { seedHistory } from './seed/history.ts'
import { seed } from './seed/seed.ts'
import { testDeps } from './test/app.ts'
import { useTestDb } from './test/db.ts'

const now = new Date('2026-11-20T12:00:00Z')

describe('live change notices', () => {
	const t = useTestDb()
	const received: string[] = []
	let hub: PgHub
	let campaignId: number
	let cardId: number
	let personKey: string
	// Every campaign that mailed that person: the ones a reply from them can count for.
	let mailedThem: string[]

	beforeAll(async () => {
		await seed(t.db, { now })
		for (const provider of ['apollo', 'factset', 'clay'] as const)
			await runIngestion(testDeps(t.db, { clock: () => now }), provider, 'system:test')
		await seedHistory(t.db, now)
		const [card] = await t.db.select().from(cards).where(isNotNull(cards.mailedAt)).limit(1)
		cardId = card!.id
		campaignId = card!.campaignId
		personKey = card!.personKey!
		const mailed = await t.db
			.selectDistinct({ campaignId: cards.campaignId })
			.from(cards)
			.where(and(eq(cards.personKey, personKey), isNotNull(cards.mailedAt)))
		mailedThem = mailed.map((row) => `results:${row.campaignId}`).sort()

		hub = createHub({
			url: t.url,
			log: createLogger({ level: 'silent' }),
			retry: { sleep: () => Promise.resolve() },
		})
		await hub.ready
		hub.subscribe((payload) => received.push(payload))
	})

	afterAll(() => hub.close())

	const touchCard = (executor: Executor = t.db) =>
		executor.update(cards).set({ statusChangedAt: now }).where(eq(cards.id, cardId))

	it('names the campaign once a card update commits', async () => {
		received.length = 0
		await touchCard()
		await vi.waitFor(() => expect(received).toEqual([`campaign:${campaignId}`]))
	})

	it('names the campaign when the campaign itself changes', async () => {
		received.length = 0
		await t.db.update(campaigns).set({ name: 'Renamed' }).where(eq(campaigns.id, campaignId))
		await vi.waitFor(() => expect(received).toEqual([`campaign:${campaignId}`]))
	})

	const logReply = (idempotencyKey: string, target: { domain?: string; personKey?: string } = { personKey }) =>
		t.db.insert(outcomeEvents).values({
			kind: 'reply',
			...target,
			occurredAt: now,
			source: 'test',
			idempotencyKey,
			createdBy: 'usr_rep_tom',
			createdAt: now,
		})

	it('names only the campaigns that mailed the person once their reply is logged', async () => {
		received.length = 0
		await logReply('live-1')
		await vi.waitFor(() => expect([...received].sort()).toEqual(mailedThem))
		expect(mailedThem).toContain(`results:${campaignId}`)
	})

	it('stays quiet for a reply that no campaign mailed', async () => {
		received.length = 0
		await logReply('live-unrelated', { domain: 'example.com' })
		// Notices arrive in commit order: a results notice for the unrelated reply would come before this one.
		await touchCard()
		await vi.waitFor(() => expect(received).toEqual([`campaign:${campaignId}`]))
	})

	it('delivers nothing for a rolled-back update', async () => {
		received.length = 0
		await expect(
			t.db.transaction(async (tx) => {
				await touchCard(tx)
				tx.rollback()
			}),
		).rejects.toThrow()
		// Notices arrive in commit order on one connection: a stray campaign notice would come before this marker.
		await logReply('live-2')
		await vi.waitFor(() => expect([...received].sort()).toEqual(mailedThem))
	})

	it('names the campaign for a visit from a company merged into the one it mailed', async () => {
		const [card] = await t.db.select().from(cards).where(eq(cards.id, cardId))
		const mailedCompanies = t.db.select({ id: cards.companyId }).from(cards).where(isNotNull(cards.mailedAt))
		const [other] = await t.db
			.select()
			.from(companyProfiles)
			.where(and(isNotNull(companyProfiles.domain), notInArray(companyProfiles.companyId, mailedCompanies)))
			.limit(1)
		const visit = (idempotencyKey: string) => logReply(idempotencyKey, { domain: other!.domain! })

		received.length = 0
		await visit('live-before-merge')
		await touchCard()
		await vi.waitFor(() => expect(received).toEqual([`campaign:${campaignId}`]))

		await mergeCompanies(t.db, {
			companyId: card!.companyId,
			otherCompanyId: other!.companyId,
			reason: 'Same group',
			actor: { id: 'usr_rep_tom', role: 'rep' },
			now,
		})
		received.length = 0
		await visit('live-after-merge')
		await vi.waitFor(() => expect(received).toContain(`results:${campaignId}`))
	})

	it('reconnects after the connection is cut, tells subscribers to resync and keeps delivering', async () => {
		received.length = 0
		await t.db.$client.query(
			`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
			 WHERE datname = current_database() AND query = 'LISTEN lumina_changes'`,
		)
		await vi.waitFor(() => expect(received).toEqual(['resync']))

		await touchCard()
		await vi.waitFor(() => expect(received).toEqual(['resync', `campaign:${campaignId}`]))
	})
})
