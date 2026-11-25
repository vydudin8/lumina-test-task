import { and, count, eq, inArray, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Manifest } from '../../../../scripts/generate-fixtures.ts'
import { auditEvents, cards, contacts, jobs, sourceCompanies, templates } from '../../db/schema.ts'
import { runNextJob, runPendingJobs, type JobDeps } from '../../jobs.ts'
import { createStubLlm } from '../../llm/stub.ts'
import type { Llm } from '../../llm/types.ts'
import { createLogger } from '../../log.ts'
import { suppressionReason } from '../../policy/suppression.ts'
import { readFixture } from '../../seed/fixtures.ts'
import { seedHistory } from '../../seed/history.ts'
import { seed } from '../../seed/seed.ts'
import { testDeps } from '../../test/app.ts'
import { createCampaignWithLines } from '../../test/campaign.ts'
import { useTestDb } from '../../test/db.ts'
import { runIngestion } from '../ingest/index.ts'
import { unmergeSource } from '../resolve/store.ts'
import {
	approveCard,
	approveCards,
	approveEligible,
	createCampaign,
	editLine,
	loadSuppressionState,
	outreachHistory,
	rejectCard,
	rejectCards,
	writeLines,
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
		const rows = await t.db.select().from(templates).orderBy(templates.id)
		templateIds = { a: rows[0]!.id, b: rows[1]!.id }
	})

	// With its lines written, as the job runner leaves it; the tests of the job itself call createCampaign.
	const build = (key: string, topN = 50) =>
		createCampaignWithLines(deps, {
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
			expect(card.personalLine!.length).toBeGreaterThan(0)
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

	it('needs two different templates that exist', async () => {
		const input = { idempotencyKey: 'bad-templates', name: 'x', topN: 5, actor: tom }
		await expect(
			createCampaign(deps, { ...input, templateAId: templateIds.a, templateBId: templateIds.a }),
		).rejects.toMatchObject({ status: 400, message: 'Pick two different templates.' })
		await expect(
			createCampaign(deps, { ...input, templateAId: templateIds.a, templateBId: 999_999 }),
		).rejects.toMatchObject({ status: 400, message: 'That template does not exist.' })
		// Any two of the three seeded templates will do: A and B are only the two slots of a campaign.
		const [, , third] = await t.db.select().from(templates).orderBy(templates.id)
		const { campaign } = await createCampaign(deps, {
			...input,
			idempotencyKey: 'swapped-templates',
			templateAId: third!.id,
			templateBId: templateIds.a,
		})
		expect(campaign).toMatchObject({ templateAId: third!.id, templateBId: templateIds.a })
	})

	it('without an A/B test, every eligible card uses the one template', async () => {
		const input = { name: 'One template', topN: 10, actor: tom, templateBId: null }
		await expect(
			createCampaign(deps, { ...input, idempotencyKey: 'single-missing', templateAId: 999_999 }),
		).rejects.toMatchObject({ status: 400, message: 'That template does not exist.' })
		const { campaign } = await createCampaign(deps, { ...input, idempotencyKey: 'single', templateAId: templateIds.b })
		expect(campaign).toMatchObject({ templateAId: templateIds.b, templateBId: null })
		const rows = await t.db.select().from(cards).where(eq(cards.campaignId, campaign.id))
		const eligible = rows.filter((card) => card.eligibility === 'eligible')
		expect(eligible.length).toBeGreaterThan(0)
		expect(eligible.every((card) => card.variant === 'A')).toBe(true)
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

	it('approves or rejects exactly the chosen drafts, one audit event each, and ignores other campaigns', async () => {
		const { campaign } = await build('key-subset', 10)
		const drafts = (
			await t.db
				.select()
				.from(cards)
				.where(and(eq(cards.campaignId, campaign.id), eq(cards.status, 'draft')))
		).sort((a, b) => a.rank - b.rank)
		const [first, second, third, fourth, fifth] = drafts.map((card) => card.id)
		const foreign = (await t.db.select().from(cards).where(eq(cards.campaignId, campaignId)).limit(1))[0]!

		await expect(approveCards(deps, { campaignId: campaign.id, cardIds: [first!], actor: tom })).rejects.toMatchObject({
			status: 403,
		})
		const result = await approveCards(deps, {
			campaignId: campaign.id,
			cardIds: [first!, second!, foreign.id, first!],
			actor: maya,
			requestId: 'req-subset',
		})
		expect(result).toEqual({ approved: 2 })
		const statuses = await t.db
			.select()
			.from(cards)
			.where(inArray(cards.id, [first!, second!, third!, foreign.id]))
		expect(statuses.map((card) => [card.id, card.status]).sort()).toEqual(
			[
				[first, 'approved'],
				[second, 'approved'],
				[third, 'draft'],
				[foreign.id, foreign.status],
			].sort(),
		)
		const approvals = await t.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'card.approved'), eq(auditEvents.requestId, 'req-subset')))
		expect(approvals.map((event) => event.entityId).sort()).toEqual([String(first), String(second)].sort())
		expect(approvals.every((event) => (event.result as { bulk?: boolean }).bulk === true)).toBe(true)
		// Already approved: nothing changes and nothing is audited.
		expect(await approveCards(deps, { campaignId: campaign.id, cardIds: [first!], actor: maya })).toEqual({
			approved: 0,
		})

		await expect(
			rejectCards(deps, { campaignId: campaign.id, cardIds: [third!], reason: '  ', actor: tom }),
		).rejects.toThrow(/reason/i)
		expect(
			await rejectCards(deps, {
				campaignId: campaign.id,
				cardIds: [first!, third!, fourth!, foreign.id],
				reason: 'Wrong people',
				actor: tom,
				requestId: 'req-reject',
			}),
		).toEqual({ rejected: 2 })
		const after = await t.db
			.select()
			.from(cards)
			.where(inArray(cards.id, [first!, third!, fourth!, foreign.id]))
		expect(after.map((card) => [card.id, card.status]).sort()).toEqual(
			[
				[first, 'approved'],
				[third, 'rejected'],
				[fourth, 'rejected'],
				[foreign.id, foreign.status],
			].sort(),
		)
		const rejections = await t.db.select().from(auditEvents).where(eq(auditEvents.requestId, 'req-reject'))
		expect(rejections.map((event) => event.entityId).sort()).toEqual([String(third), String(fourth)].sort())
		expect(rejections.every((event) => event.action === 'card.rejected' && event.reason === 'Wrong people')).toBe(true)
		expect(rejections.every((event) => (event.result as { bulk?: boolean }).bulk === true)).toBe(true)

		// An approved card is no draft any more, so rejecting it changes nothing.
		expect(
			await rejectCards(deps, { campaignId: campaign.id, cardIds: [second!], reason: 'Late', actor: tom }),
		).toEqual({
			rejected: 0,
		})
		expect(await t.db.select().from(cards).where(eq(cards.id, second!))).toMatchObject([{ status: 'approved' }])

		// A single id is not a bulk action.
		await rejectCards(deps, { campaignId: campaign.id, cardIds: [fifth!], reason: 'Duplicate', actor: tom })
		const [single] = await t.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'card.rejected'), eq(auditEvents.entityId, String(fifth))))
		expect(single!.result).toBeNull()
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

	it('gives a card one Idempotency-Key when two approvals race', async () => {
		const { campaign } = await build('key-race', 5)
		const [card] = await t.db
			.select()
			.from(cards)
			.where(and(eq(cards.campaignId, campaign.id), eq(cards.status, 'draft'), eq(cards.eligibility, 'eligible')))
			.limit(1)
		const results = await Promise.all([
			approveCard(deps, { cardId: card!.id, actor: maya }),
			approveCard(deps, { cardId: card!.id, actor: maya }),
			approveCards(deps, { campaignId: campaign.id, cardIds: [card!.id], actor: maya }),
		])
		const [stored] = await t.db.select().from(cards).where(eq(cards.id, card!.id))
		expect(stored?.idempotencyKey).toBeTruthy()
		expect([results[0].changed, results[1].changed, results[2].approved === 1].filter(Boolean)).toHaveLength(1)
		expect([results[0].card.idempotencyKey, results[1].card.idempotencyKey]).toEqual([
			stored!.idempotencyKey,
			stored!.idempotencyKey,
		])
		const approvals = await t.db
			.select({ key: sql<string>`${auditEvents.result}->>'idempotencyKey'` })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'card.approved'), eq(auditEvents.entityId, String(card!.id))))
		expect(approvals).toEqual([{ key: stored!.idempotencyKey }])
	})
	describe('personal lines in the background', () => {
		// The stub, counting how often the model is asked.
		const counting = () => {
			const inner = createStubLlm({ hallucinateEvery: 0 })
			const llm: Llm & { calls: number } = {
				...inner,
				calls: 0,
				generate: (request) => {
					llm.calls++
					return inner.generate(request)
				},
			}
			return llm
		}
		const create = (key: string, llm: Llm) =>
			createCampaign(
				{ ...deps, llm },
				{
					idempotencyKey: key,
					name: 'Lines',
					topN: 12,
					templateAId: templateIds.a,
					templateBId: templateIds.b,
					actor: tom,
				},
			)
		const lineRows = async (id: number) =>
			(await t.db.select().from(cards).where(eq(cards.campaignId, id))).sort((a, b) => a.rank - b.rank)
		const jobsOf = (id: number) =>
			t.db
				.select()
				.from(jobs)
				.where(eq(jobs.key, String(id)))

		it('builds the cards without asking the model, and queues one job; a repeated key queues no second', async () => {
			const llm = counting()
			const { campaign } = await create('lines-first', llm)
			expect(llm.calls).toBe(0)

			const rows = await lineRows(campaign.id)
			const eligible = rows.filter((card) => card.eligibility === 'eligible')
			expect(eligible.length).toBeGreaterThan(0)
			expect(eligible.every((card) => card.personalLine === null && card.lineSource === null)).toBe(true)
			// A blocked card is never mailed: it keeps the template line.
			expect(rows.filter((card) => card.eligibility === 'blocked').every((card) => card.personalLine !== null)).toBe(
				true,
			)
			expect(await jobsOf(campaign.id)).toMatchObject([{ kind: 'campaign.lines', status: 'queued' }])

			expect(await create('lines-first', llm)).toMatchObject({ created: false })
			expect(await jobsOf(campaign.id)).toHaveLength(1)
			expect(llm.calls).toBe(0)
		})

		it('refuses to approve a card without its line, in the API and in the database', async () => {
			const llm = counting()
			const { campaign } = await create('lines-approve', llm)
			const [pending] = (await lineRows(campaign.id)).filter((card) => card.eligibility === 'eligible')

			await expect(approveCard(deps, { cardId: pending!.id, actor: maya })).rejects.toMatchObject({ status: 409 })
			// Bulk approval skips such cards instead of failing the rest.
			expect(await approveEligible(deps, { campaignId: campaign.id, actor: maya })).toEqual({ approved: 0 })
			expect(await approveCards(deps, { campaignId: campaign.id, cardIds: [pending!.id], actor: maya })).toEqual({
				approved: 0,
			})
			await expect(
				t.db.execute(
					sql`UPDATE cards SET status = 'approved', approved_by = 'usr_lead_maya', approved_by_role = 'lead', approved_at = now(), idempotency_key = 'k' WHERE id = ${pending!.id}`,
				),
			).rejects.toMatchObject({ cause: { constraint: 'cards_line_present' } })
			// A line comes with its source, never one without the other.
			await expect(
				t.db.execute(sql`UPDATE cards SET personal_line = 'Hi' WHERE id = ${pending!.id}`),
			).rejects.toMatchObject({ cause: { constraint: 'cards_line_source' } })

			await writeLines({ ...deps, llm }, campaign.id)
			expect(await approveCard(deps, { cardId: pending!.id, actor: maya })).toMatchObject({ changed: true })
		})

		it('writes every line once, audits it, and a repeat of the job asks the model for nothing', async () => {
			const llm = counting()
			const { campaign } = await create('lines-all', llm)
			const eligible = (await lineRows(campaign.id)).filter((card) => card.eligibility === 'eligible').length
			await writeLines({ ...deps, llm }, campaign.id)

			expect(llm.calls).toBe(eligible)
			const rows = (await lineRows(campaign.id)).filter((card) => card.eligibility === 'eligible')
			expect(
				rows.every((card) => card.personalLine && card.lineCites.length > 0 && card.llmStatus === 'accepted'),
			).toBe(true)
			expect(rows.every((card) => card.lineSource === 'llm')).toBe(true)
			const written = await t.db
				.select()
				.from(auditEvents)
				.where(and(eq(auditEvents.action, 'campaign.lines_written'), eq(auditEvents.entityId, String(campaign.id))))
			expect(written).toMatchObject([{ result: { eligible, llmRejected: 0 } }])
			// Each batch commits its cards with their own audit rows, so a job that dies halfway leaves none unexplained.
			const perCard = await t.db
				.select({ entityId: auditEvents.entityId, after: auditEvents.after })
				.from(auditEvents)
				.where(
					and(
						eq(auditEvents.action, 'card.line_written'),
						inArray(
							auditEvents.entityId,
							rows.map((card) => String(card.id)),
						),
					),
				)
			expect(perCard.map((row) => row.entityId).sort()).toEqual(rows.map((card) => String(card.id)).sort())
			expect(perCard.every((row) => (row.after as { lineSource: string }).lineSource === 'llm')).toBe(true)

			await writeLines({ ...deps, llm }, campaign.id)
			expect(llm.calls).toBe(eligible)
		})

		it('keeps the guard: a made-up number falls back to the template, with raw output and an audit event', async () => {
			const llm = createStubLlm({ hallucinateEvery: 1 })
			const { campaign } = await create('lines-guard', llm)
			await writeLines({ ...deps, llm }, campaign.id)
			const rows = (await lineRows(campaign.id)).filter((card) => card.eligibility === 'eligible')
			expect(rows.every((card) => card.llmStatus === 'rejected' && card.lineSource === 'template' && card.llmRaw)).toBe(
				true,
			)
			expect(rows[0]!.llmRejections.map((rejection) => rejection.code)).toContain('uncited_number')
			const events = await t.db
				.select()
				.from(auditEvents)
				.where(
					and(
						eq(auditEvents.action, 'llm.output_rejected'),
						inArray(
							auditEvents.entityId,
							rows.map((card) => String(card.id)),
						),
					),
				)
			expect(events).toHaveLength(rows.length)
		})

		it('resumes after a crash where it stopped: each card is paid for once', async () => {
			const llm = counting()
			const { campaign } = await create('lines-crash', llm)
			const eligible = (await lineRows(campaign.id)).filter((card) => card.eligibility === 'eligible').length
			expect(eligible).toBeGreaterThan(5)

			// The second batch dies before it reaches the model (generateGrounded opens its logger first).
			let started = 0
			const silent = createLogger({ level: 'silent' })
			const dying = {
				child: () => {
					if (started++ >= 5) throw new Error('process died')
					return silent
				},
			} as never
			await expect(writeLines({ ...deps, llm, log: dying }, campaign.id)).rejects.toThrow()
			expect(llm.calls).toBe(5)
			const midway = (await lineRows(campaign.id)).filter((card) => card.eligibility === 'eligible')
			expect(midway.filter((card) => card.personalLine !== null)).toHaveLength(5)

			await writeLines({ ...deps, llm }, campaign.id)
			expect(llm.calls).toBe(eligible)
			expect((await lineRows(campaign.id)).every((card) => card.personalLine !== null)).toBe(true)
		})

		it('never overwrites a line a person wrote while the job was running', async () => {
			const llm = counting()
			const { campaign } = await create('lines-human', llm)
			const [first, second] = (await lineRows(campaign.id)).filter((card) => card.eligibility === 'eligible')
			// A person writes a line for the first card, and the job's model call is already under way for it.
			const slow: Llm = {
				...llm,
				generate: async (request) => {
					const answer = await llm.generate(request)
					if (!(await t.db.select().from(cards).where(eq(cards.id, first!.id)))[0]!.personalLine)
						await editLine(deps, { cardId: first!.id, text: 'Written by hand.', actor: tom })
					return answer
				},
			}
			await writeLines({ ...deps, llm: slow }, campaign.id)

			const [kept] = await t.db.select().from(cards).where(eq(cards.id, first!.id))
			expect(kept).toMatchObject({ personalLine: 'Written by hand.', lineSource: 'human', llmStatus: null })
			const [filled] = await t.db.select().from(cards).where(eq(cards.id, second!.id))
			expect(filled).toMatchObject({ lineSource: 'llm' })
		})

		it('has the job runner do it all from the queued job', async () => {
			const llm = counting()
			const { campaign } = await create('lines-runner', llm)
			await runPendingJobs({
				db: t.db,
				log: createLogger({ level: 'silent' }),
				clock: () => now,
				retry: {},
				handlers: { 'campaign.lines': (job) => writeLines({ ...deps, llm }, job.payload.campaignId as number) },
			})
			expect(await jobsOf(campaign.id)).toMatchObject([{ status: 'done' }])
			expect((await lineRows(campaign.id)).every((card) => card.personalLine !== null)).toBe(true)
		})

		// After the test above, so this campaign's job is the only one queued.
		it('stops after the batch in hand when the server shuts down, and queues the job again without counting it', async () => {
			const llm = counting()
			const { campaign } = await create('lines-stop', llm)
			const eligible = (await lineRows(campaign.id)).filter((card) => card.eligibility === 'eligible').length
			expect(eligible).toBeGreaterThan(5)
			const shutdown = new AbortController()
			const jobDeps = (model: Llm): JobDeps => ({
				db: t.db,
				log: createLogger({ level: 'silent' }),
				clock: () => now,
				retry: {},
				handlers: {
					'campaign.lines': (job, _lastTry, stopping) =>
						writeLines({ ...deps, llm: model }, job.payload.campaignId as number, stopping),
				},
			})
			// SIGTERM arrives while the model writes the first batch.
			const interrupted: Llm = { ...llm, generate: (request) => (shutdown.abort(), llm.generate(request)) }
			expect(await runNextJob(jobDeps(interrupted), shutdown.signal)).toBe(true)

			expect(llm.calls).toBe(5)
			const midway = (await lineRows(campaign.id)).filter((card) => card.eligibility === 'eligible')
			expect(midway.filter((card) => card.personalLine !== null)).toHaveLength(5)
			expect(await jobsOf(campaign.id)).toMatchObject([{ status: 'queued', attempts: 0, startedAt: null }])

			// The next process picks it up where it stopped.
			await runPendingJobs(jobDeps(llm))
			expect(await jobsOf(campaign.id)).toMatchObject([{ status: 'done', attempts: 1 }])
			expect(llm.calls).toBe(eligible)
		})
	})
})
