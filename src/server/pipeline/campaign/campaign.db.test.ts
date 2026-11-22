import { and, count, eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Manifest } from '../../../../scripts/generate-fixtures.ts'
import { auditEvents, cards, contacts, sourceCompanies, templates } from '../../db/schema.ts'
import { createStubLlm } from '../../llm/stub.ts'
import { createLogger } from '../../log.ts'
import { suppressionReason } from '../../policy/suppression.ts'
import { readFixture } from '../../seed/fixtures.ts'
import { seedHistory } from '../../seed/history.ts'
import { seed } from '../../seed/seed.ts'
import { testDeps } from '../../test/app.ts'
import { useTestDb } from '../../test/db.ts'
import { runIngestion } from '../ingest/index.ts'
import { unmergeSource } from '../resolve/store.ts'
import {
	approveCard,
	approveEligible,
	createCampaign,
	editLine,
	loadSuppressionState,
	outreachHistory,
	rejectCard,
} from './store.ts'

const manifest = readFixture<Manifest>('manifest.json')
const now = new Date(`${manifest.anchor}T12:00:00Z`)
const maya = { id: 'usr_lead_maya', role: 'lead' } as const
const tom = { id: 'usr_rep_tom', role: 'rep' } as const

describe('campaign builder', () => {
	const t = useTestDb()
	let deps: Parameters<typeof createCampaign>[0]
	let templateIds: { a: number; b: number }
	let campaignId: number

	beforeAll(async () => {
		await seed(t.db, { now })
		const ingest = testDeps(t.db, { clock: () => now })
		for (const provider of ['apollo', 'factset', 'clay'] as const) await runIngestion(ingest, provider, 'system:test')
		await seedHistory(t.db, now)
		deps = { db: t.db, llm: createStubLlm(), log: createLogger({ level: 'silent' }), retry: {}, clock: () => now }
		const rows = await t.db.select().from(templates).orderBy(templates.variant)
		templateIds = { a: rows[0]!.id, b: rows[1]!.id }
	})

	const build = (key: string, topN = 50) =>
		createCampaign(deps, {
			idempotencyKey: key,
			name: 'Top 50',
			topN,
			templateAId: templateIds.a,
			templateBId: templateIds.b,
			actor: tom,
		})

	const companyOf = async (record: { provider: string; externalId: string }) => {
		const [row] = await t.db
			.select({ companyId: sourceCompanies.companyId })
			.from(sourceCompanies)
			.where(and(eq(sourceCompanies.provider, record.provider), eq(sourceCompanies.externalId, record.externalId)))
		return row!.companyId!
	}

	it('seeds the pilot and historical mailings once, however often the seed runs', async () => {
		const before = await t.db.select({ n: count() }).from(cards)
		await seedHistory(t.db, new Date(now.getTime() + 86_400_000))
		expect(await t.db.select({ n: count() }).from(cards)).toEqual(before)
		expect(before).toEqual([{ n: 45 }])
	})

	it('turns the top 50 into exactly 39 eligible cards; the other 11 are blocked with the seeded reasons', async () => {
		const { campaign, created } = await build('key-1')
		campaignId = campaign.id
		expect(created).toBe(true)

		const rows = await t.db.select().from(cards).where(eq(cards.campaignId, campaign.id))
		expect(rows).toHaveLength(50)
		expect(rows.filter((card) => card.eligibility === 'eligible')).toHaveLength(39)

		for (const expected of manifest.top50.companies) {
			const companyId = await companyOf(expected.records[0]!)
			const actual = rows.find((row) => row.companyId === companyId)
			expect(actual, expected.name).toBeDefined()
			expect(actual?.personKey, expected.name).toBe(expected.recipient)
			expect(actual?.eligibility === 'eligible' ? 'eligible' : actual?.blockReason, expected.name).toBe(
				expected.expected,
			)
		}
	})

	it('splits eligible cards A, B, A, B in rank order and writes a cited line for each', async () => {
		const rows = (
			await t.db
				.select()
				.from(cards)
				.where(and(eq(cards.campaignId, campaignId), eq(cards.eligibility, 'eligible')))
		).sort((a, b) => a.rank - b.rank)
		expect(rows.map((card) => card.variant).join('')).toBe('AB'.repeat(20).slice(0, 39))
		for (const card of rows) {
			expect(card.personalLine.length).toBeGreaterThan(0)
			expect(card.lineCites.length).toBeGreaterThan(0)
			expect(['accepted', 'rejected']).toContain(card.llmStatus)
		}
		const blocked = await t.db
			.select()
			.from(cards)
			.where(and(eq(cards.campaignId, campaignId), eq(cards.eligibility, 'blocked')))
		expect(blocked.every((card) => card.status === 'blocked' && card.variant === null)).toBe(true)
	})

	it('snapshots where each address came from and flags the one the providers disagree on', async () => {
		const rows = await t.db.select().from(cards).where(eq(cards.campaignId, campaignId))
		const conflict = manifest.addressConflicts.find((entry) => entry.inTop50)!
		const duplicate = manifest.duplicates.find((d) => d.companyKey === conflict.companyKey)!
		const conflictCompanyId = await companyOf(duplicate.records[0]!)

		const flagged = rows.find((card) => card.companyId === conflictCompanyId)!
		expect(flagged).toMatchObject({ eligibility: 'eligible', addressSource: { provider: 'apollo', conflict: true } })
		expect(flagged.address?.line1).not.toBe('2 Old Station Yard')
		expect(rows.filter((card) => card.addressSource?.conflict).map((card) => card.companyId)).toEqual([
			conflictCompanyId,
		])
		expect(rows.every((card) => !card.address || card.addressSource?.rawRecordId)).toBe(true)
	})

	it('picks recipients by the fixed chain, including the seeded tie-breaks', async () => {
		const rows = await t.db.select().from(cards).where(eq(cards.campaignId, campaignId))
		for (const tie of manifest.recipientTieBreaks) {
			const card = rows.find((row) => row.personKey === tie.winner)
			expect(card?.recipient).toMatchObject({ decidedBy: tie.rule })
			expect(card?.recipient!.candidates.map((candidate) => candidate.personKey)).toContain(tie.loser)
		}
	})

	it('returns the same campaign for a repeated Idempotency-Key and refuses the key for a different request', async () => {
		const again = await build('key-1')
		expect(again).toMatchObject({ created: false, campaign: { id: campaignId } })
		expect(await t.db.select({ n: count() }).from(cards).where(eq(cards.campaignId, campaignId))).toEqual([{ n: 50 }])
		await expect(build('key-1', 20)).rejects.toThrow(/already used/)
	})

	it('lets only a lead approve, in the API layer and in the database itself', async () => {
		const [card] = await t.db
			.select()
			.from(cards)
			.where(and(eq(cards.campaignId, campaignId), eq(cards.status, 'draft')))
			.limit(1)
		await expect(approveCard(deps, { cardId: card!.id, actor: tom })).rejects.toMatchObject({ status: 403 })

		const forged = t.db.execute(
			sql`UPDATE cards SET status = 'approved', approved_by = 'usr_rep_tom', approved_by_role = 'rep', approved_at = now(), idempotency_key = 'x' WHERE id = ${card!.id}`,
		)
		await expect(forged).rejects.toMatchObject({ cause: { constraint: 'cards_approver_is_lead' } })
		const disguised = t.db.execute(
			sql`UPDATE cards SET status = 'approved', approved_by = 'usr_rep_tom', approved_by_role = 'lead', approved_at = now(), idempotency_key = 'x' WHERE id = ${card!.id}`,
		)
		await expect(disguised).rejects.toMatchObject({ cause: { constraint: 'cards_approved_by_user_role' } })
		const roleless = t.db.execute(
			sql`UPDATE cards SET status = 'approved', approved_by = 'usr_rep_tom', approved_at = now(), idempotency_key = 'x' WHERE id = ${card!.id}`,
		)
		await expect(roleless).rejects.toMatchObject({ cause: { constraint: 'cards_approver_has_role' } })
		const anonymous = t.db.execute(sql`UPDATE cards SET status = 'approved' WHERE id = ${card!.id}`)
		await expect(anonymous).rejects.toMatchObject({ cause: { constraint: 'cards_approval_recorded' } })
	})

	it('approves once: a repeat is a no-op without a second audit event, and a blocked card cannot be approved', async () => {
		const [card] = await t.db
			.select()
			.from(cards)
			.where(and(eq(cards.campaignId, campaignId), eq(cards.status, 'draft')))
			.limit(1)
		const first = await approveCard(deps, { cardId: card!.id, actor: maya })
		expect(first).toMatchObject({
			changed: true,
			card: { status: 'approved', approvedBy: 'usr_lead_maya', approvedByRole: 'lead' },
		})
		expect(first.card.idempotencyKey).toBeTruthy()
		const second = await approveCard(deps, { cardId: card!.id, actor: maya })
		expect(second).toMatchObject({
			changed: false,
			card: { status: 'approved', idempotencyKey: first.card.idempotencyKey },
		})
		expect(
			await t.db
				.select({ n: count() })
				.from(auditEvents)
				.where(and(eq(auditEvents.action, 'card.approved'), eq(auditEvents.entityId, String(card!.id)))),
		).toEqual([{ n: 1 }])

		const [blocked] = await t.db
			.select()
			.from(cards)
			.where(and(eq(cards.campaignId, campaignId), eq(cards.status, 'blocked')))
			.limit(1)
		expect(await approveCard(deps, { cardId: blocked!.id, actor: maya })).toMatchObject({
			changed: false,
			card: { status: 'blocked' },
		})
	})

	it('needs a reason to reject, and editing an approved line sends the card back to draft', async () => {
		const drafts = await t.db
			.select()
			.from(cards)
			.where(and(eq(cards.campaignId, campaignId), eq(cards.status, 'draft')))
			.limit(2)
		await expect(rejectCard(deps, { cardId: drafts[0]!.id, reason: ' ', actor: tom })).rejects.toThrow(/reason/i)
		expect(await rejectCard(deps, { cardId: drafts[0]!.id, reason: 'Wrong person', actor: tom })).toMatchObject({
			card: { status: 'rejected', rejectReason: 'Wrong person' },
		})

		await approveCard(deps, { cardId: drafts[1]!.id, actor: maya })
		const edited = await editLine(deps, { cardId: drafts[1]!.id, text: 'Hello from Lumina.', actor: tom })
		expect(edited.card).toMatchObject({
			status: 'draft',
			approvedBy: null,
			idempotencyKey: null,
			personalLine: 'Hello from Lumina.',
			lineSource: 'human',
		})
		const [event] = await t.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'card.line_edited'), eq(auditEvents.entityId, String(drafts[1]!.id))))
		expect(event).toMatchObject({
			before: { status: 'approved' },
			after: { status: 'draft', personalLine: 'Hello from Lumina.' },
		})
	})

	it('bulk approve takes only eligible drafts and audits each card', async () => {
		const result = await approveEligible(deps, { campaignId, actor: maya })
		const approved = await t.db
			.select()
			.from(cards)
			.where(and(eq(cards.campaignId, campaignId), eq(cards.status, 'approved')))
		expect(result.approved).toBe(approved.length - 1)
		expect(approved).toHaveLength(38)
		expect(await t.db.select({ n: count() }).from(auditEvents).where(eq(auditEvents.action, 'card.approved'))).toEqual([
			{ n: 38 + 1 },
		])
	})

	it('keeps outreach history and the 90-day rule after the recipient record is split off its company', async () => {
		const pilot = manifest.suppressed.find(
			(person) =>
				person.reason === 'mailed_90d' &&
				person.inTop50 &&
				manifest.duplicates.some((d) => d.companyKey === person.companyKey),
		)!
		const [contact] = await t.db.select().from(contacts).where(eq(contacts.personKey, pilot.personKey))
		const [source] = await t.db.select().from(sourceCompanies).where(eq(sourceCompanies.id, contact!.sourceCompanyId!))
		await unmergeSource(t.db, {
			companyId: source!.companyId!,
			sourceId: source!.id,
			reason: 'Testing history',
			actor: tom,
			now,
		})

		const history = await outreachHistory(t.db, pilot.personKey)
		expect(history).toEqual([expect.objectContaining({ campaignName: 'Pilot: plant hire firms', status: 'delivered' })])
		expect(suppressionReason(pilot.personKey, await loadSuppressionState(t.db), now)).toBe('mailed_90d')
	})

	it('keeps a top company with no contact on file as a blocked card instead of dropping it', async () => {
		const expected = manifest.top50.companies.find((company) => company.expected === 'eligible')!
		const companyId = await companyOf(expected.records[0]!)
		await t.db.execute(
			sql`UPDATE contacts SET source_company_id = NULL WHERE source_company_id IN (SELECT id FROM source_companies WHERE company_id = ${companyId})`,
		)

		const { campaign } = await build('key-no-contact')
		const rows = await t.db.select().from(cards).where(eq(cards.campaignId, campaign.id))
		expect(rows).toHaveLength(50)
		expect(rows.find((card) => card.companyId === companyId)).toMatchObject({
			eligibility: 'blocked',
			status: 'blocked',
			blockReason: 'no_contact',
			contactId: null,
			personKey: null,
			recipient: null,
		})

		// Only a no-contact card may lack a recipient, even through direct SQL.
		const eligible = rows.find((card) => card.eligibility === 'eligible')!
		await expect(
			t.db.execute(
				sql`UPDATE cards SET contact_id = NULL, person_key = NULL, recipient = NULL WHERE id = ${eligible.id}`,
			),
		).rejects.toMatchObject({ cause: { constraint: 'cards_recipient_present' } })
	})
})
