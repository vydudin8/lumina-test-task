import { and, asc, count, desc, eq, inArray, isNotNull, isNull, max, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { audit, systemActor } from '../../audit.ts'
import type { Db, Executor, Tx } from '../../db/client.ts'
import { campaigns, cards, contacts, sourceCompanies, suppressions, templates } from '../../db/schema.ts'
import { enqueueJob, JOB_KINDS, JobInterrupted } from '../../jobs.ts'
import type { Clock } from '../../lib/clock.ts'
import { DomainError } from '../../lib/errors.ts'
import { generateGrounded, type LlmDeps } from '../../llm/generate.ts'
import { contactDataIn } from '../../llm/guard.ts'
import { personKeyHash } from '../../policy/person-key.ts'
import { chooseRecipient } from '../../policy/recipient.ts'
import type { SuppressionState } from '../../policy/suppression.ts'
import { profileFields } from '../resolve/store.ts'
import { icpVersion, topRanked } from '../score/store.ts'
import { blockReason, cardLineEvidence, fallbackLine } from './core.ts'

type UserActor = { id: string; role: 'rep' | 'lead' }

export interface CampaignDeps extends LlmDeps {
	db: Db
	clock: Clock
}

export type Card = typeof cards.$inferSelect

const LINE_MAX_CHARS = 200
const LLM_CONCURRENCY = 5

// A card whose submission could not be confirmed may have been printed, so it holds the person back like a sent one.
const sentAt = sql<Date>`coalesce(${cards.submittedAt}, CASE WHEN ${cards.status} = 'unconfirmed' THEN ${cards.statusChangedAt} END)`

export async function loadSuppressionState(executor: Executor): Promise<SuppressionState> {
	const optOuts = await executor.select({ hash: suppressions.personKeyHash }).from(suppressions)
	const submitted = await executor
		.select({ personKey: cards.personKey, last: max(sentAt) })
		.from(cards)
		.where(sql`${sentAt} IS NOT NULL`)
		.groupBy(cards.personKey)
	return {
		optOutHashes: new Set(optOuts.map((row) => row.hash)),
		// Only a no-contact card lacks a person, and it is never sent (cards_recipient_present).
		lastSubmitted: new Map(submitted.map((row) => [row.personKey!, new Date(row.last!)])),
	}
}

// The same state for one person, two index lookups (suppressions_personKeyHash_unique, cards_person_key): what the send
// worker checks before each card, at a cost that does not grow with the mailing history.
export async function loadPersonSuppression(executor: Executor, personKey: string): Promise<SuppressionState> {
	const optOut = await executor
		.select({ hash: suppressions.personKeyHash })
		.from(suppressions)
		.where(eq(suppressions.personKeyHash, personKeyHash(personKey)))
	const [sent] = await executor
		.select({ last: max(sentAt) })
		.from(cards)
		.where(eq(cards.personKey, personKey))
	return {
		optOutHashes: new Set(optOut.map((row) => row.hash)),
		lastSubmitted: new Map(sent?.last ? [[personKey, new Date(sent.last)]] : []),
	}
}

export interface CreateCampaignInput {
	idempotencyKey: string
	name: string
	topN: number
	templateAId: number
	// Null for a campaign without an A/B test.
	templateBId: number | null
	icpVersionId?: number
	actor: UserActor
	requestId?: string
}

// Snapshots the ICP version, scores, recipients and addresses at build time and queues the job that writes the lines,
// so the request never waits for the model. Safe to retry with the same key: that finds the campaign, never a second job.
export async function createCampaign(deps: CampaignDeps, input: CreateCampaignInput) {
	const now = deps.clock()
	const { idempotencyKey, actor, requestId, ...request } = input
	const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex')

	const existing = async (executor: Executor) => {
		const [campaign] = await executor.select().from(campaigns).where(eq(campaigns.idempotencyKey, idempotencyKey))
		if (campaign && campaign.requestHash !== requestHash) {
			throw new DomainError('This Idempotency-Key was already used for a different campaign. Use a new key.', 409)
		}
		return campaign
	}
	const found = await existing(deps.db)
	if (found) return { campaign: found, created: false }

	if (input.templateAId === input.templateBId) throw new DomainError('Pick two different templates.')
	const templateIds = input.templateBId === null ? [input.templateAId] : [input.templateAId, input.templateBId]
	const chosenTemplates = await deps.db
		.select({ id: templates.id })
		.from(templates)
		.where(inArray(templates.id, templateIds))
	if (chosenTemplates.length !== templateIds.length) throw new DomainError('That template does not exist.')
	const abTest = input.templateBId !== null

	const icp = await icpVersion(deps.db, input.icpVersionId)
	const ranked = await topRanked(deps.db, icp.id, input.topN)
	if (ranked.length === 0) throw new DomainError('No company is in the profile, so there is nobody to mail.')
	const companyIds = ranked.map((row) => row.companyId)
	const fields = await profileFields(deps.db, companyIds, now)
	const top = ranked.map((row) => ({ ...row, company: { id: row.companyId, fields: fields.get(row.companyId)! } }))

	const contactRows = await deps.db
		.select({ contact: contacts, companyId: sourceCompanies.companyId })
		.from(contacts)
		.innerJoin(sourceCompanies, eq(contacts.sourceCompanyId, sourceCompanies.id))
		.where(inArray(sourceCompanies.companyId, companyIds))
		.orderBy(contacts.id)
	// Contacts are read through their record, so each has one.
	const sourceOfContact = new Map(contactRows.map(({ contact }) => [contact.id, contact.sourceCompanyId!]))
	const suppression = await loadSuppressionState(deps.db)

	let variantIndex = 0
	const drafts = top.map((row) => {
		const choice = chooseRecipient(
			contactRows
				.filter((contact) => contact.companyId === row.company.id)
				.map(({ contact }) => ({ ...contact, fetchedAt: contact.fetchedAt.toISOString() })),
		)
		const address = row.company.fields.address.value
		// A company with no listed person still gets a (blocked) card, so it shows as skipped rather than vanishing.
		const blocked = choice ? blockReason(choice.chosen.personKey, address, suppression, now) : 'no_contact'
		const evidence = cardLineEvidence(choice?.chosen ?? null, row.company)
		return {
			row,
			choice,
			address,
			blocked,
			evidence,
			variant: blocked ? null : !abTest || variantIndex++ % 2 === 0 ? ('A' as const) : ('B' as const),
		}
	})

	return deps.db.transaction(async (tx) => {
		const [campaign] = await tx
			.insert(campaigns)
			.values({ ...request, idempotencyKey, requestHash, icpVersionId: icp.id, createdBy: actor.id, createdAt: now })
			.onConflictDoNothing({ target: campaigns.idempotencyKey })
			.returning()
		// Lost a race with the same key: the other request built it.
		if (!campaign) return { campaign: (await existing(tx))!, created: false }

		const inserted = await tx
			.insert(cards)
			.values(
				drafts.map((draft) => {
					// A blocked card is never mailed, so it gets the template at once; an eligible one waits for its line.
					const fallback = draft.blocked ? fallbackLine(draft.evidence) : null
					const chosen = draft.choice?.chosen
					return {
						campaignId: campaign.id,
						companyId: draft.row.company.id,
						sourceCompanyId: chosen ? sourceOfContact.get(chosen.contactId)! : null,
						contactId: chosen?.contactId ?? null,
						personKey: chosen?.personKey ?? null,
						rank: draft.row.rank,
						score: draft.row.score.score,
						scoreDisplay: draft.row.score.display,
						contributions: draft.row.score.contributions,
						recipient: chosen
							? {
									fullName: chosen.fullName,
									firstName: chosen.firstName,
									title: chosen.title,
									function: chosen.function,
									seniority: chosen.seniority,
									providers: chosen.providers,
									decidedBy: draft.choice!.decidedBy,
									candidates: draft.choice!.candidates,
								}
							: null,
						address: draft.address as Record<string, string | null> | null,
						addressSource: {
							provider: draft.row.company.fields.address.provider,
							rawRecordId: draft.row.company.fields.address.rawRecordId,
							conflict: draft.row.company.fields.address.conflict,
							chosenBy: draft.row.company.fields.address.override?.createdBy ?? null,
						},
						eligibility: draft.blocked ? ('blocked' as const) : ('eligible' as const),
						blockReason: draft.blocked,
						variant: draft.variant,
						personalLine: fallback?.text ?? null,
						lineSource: fallback ? ('template' as const) : null,
						lineCites: fallback?.cites ?? [],
						lineEvidence: draft.evidence,
						status: draft.blocked ? ('blocked' as const) : ('draft' as const),
						statusChangedAt: now,
						createdAt: now,
					}
				}),
			)
			.onConflictDoNothing()
			.returning()
		const eligible = inserted.filter((card) => card.eligibility === 'eligible').length

		await audit(tx, {
			actor,
			action: 'campaign.created',
			entityType: 'campaign',
			entityId: campaign.id,
			after: { name: campaign.name, topN: campaign.topN, icpVersionId: icp.id },
			result: { cards: inserted.length, eligible },
			requestId,
		})
		if (eligible > 0)
			await enqueueJob(
				tx,
				{ kind: JOB_KINDS.lines, key: String(campaign.id), payload: { campaignId: campaign.id }, createdBy: actor.id },
				now,
			)
		return { campaign, created: true }
	})
}

// The "write lines" job. Fills the cards that still have no line, five at a time, committing each batch: a crash
// resumes with what is left and never asks the model twice for a card, and a line a person wrote meanwhile is never
// overwritten (the update only touches a card whose line is still empty).
// shortcut: a job that fails for good leaves its cards empty (the page says why); a person writes the lines by hand.
// Add a "run again" action when that happens in practice.
export async function writeLines(deps: CampaignDeps, campaignId: number, stopping?: AbortSignal) {
	for (;;) {
		// Between batches, so a shutdown loses no answer the model already gave.
		if (stopping?.aborted) throw new JobInterrupted()
		const batch = await deps.db
			.select()
			.from(cards)
			.where(and(eq(cards.campaignId, campaignId), isNull(cards.personalLine), eq(cards.status, 'draft')))
			.orderBy(asc(cards.rank))
			.limit(LLM_CONCURRENCY)
		if (batch.length === 0) return

		const lines = await Promise.all(
			batch.map((card) =>
				generateGrounded(
					deps,
					{
						task: 'card_line',
						purpose: `Write the opening line of a postcard to ${card.recipient?.firstName ?? 'the recipient'} at ${card.lineEvidence.find((item) => item.label === 'company')?.value ?? 'their company'}.`,
						evidence: card.lineEvidence,
						maxChars: LINE_MAX_CHARS,
					},
					fallbackLine(card.lineEvidence),
				),
			),
		)

		await deps.db.transaction(async (tx) => {
			let written = 0
			for (const [index, card] of batch.entries()) {
				const line = lines[index]!
				const [filled] = await tx
					.update(cards)
					.set({
						personalLine: line.text,
						lineSource: line.status === 'accepted' ? 'llm' : 'template',
						lineCites: line.cites,
						llmStatus: line.status,
						llmRejections: line.rejections,
						llmRaw: line.raw,
						llmModel: line.model,
						promptVersion: line.promptVersion,
					})
					.where(and(eq(cards.id, card.id), isNull(cards.personalLine), eq(cards.status, 'draft')))
					.returning({ id: cards.id })
				if (!filled) continue
				written++
				await audit(tx, {
					actor: systemActor('llm'),
					action: 'card.line_written',
					entityType: 'card',
					entityId: card.id,
					before: { personalLine: null },
					after: { personalLine: line.text, lineSource: line.status === 'accepted' ? 'llm' : 'template' },
					result: { model: line.model, promptVersion: line.promptVersion },
				})
				if (line.status === 'rejected')
					await audit(tx, {
						actor: systemActor('llm'),
						action: 'llm.output_rejected',
						entityType: 'card',
						entityId: card.id,
						reason: line.rejections.map((rejection) => rejection.code).join(','),
						result: { task: 'card_line', rejections: line.rejections, model: line.model },
					})
			}
			if (written === 0) return
			const [{ pending }] = (await tx
				.select({ pending: count() })
				.from(cards)
				.where(and(eq(cards.campaignId, campaignId), isNull(cards.personalLine), eq(cards.status, 'draft')))) as [
				{ pending: number },
			]
			if (pending > 0) return
			const [{ eligible, rejected }] = (await tx
				.select({
					eligible: count(),
					rejected: sql<number>`count(*) filter (where ${cards.llmStatus} = 'rejected')`.mapWith(Number),
				})
				.from(cards)
				.where(and(eq(cards.campaignId, campaignId), eq(cards.eligibility, 'eligible')))) as [
				{ eligible: number; rejected: number },
			]
			await audit(tx, {
				actor: systemActor('llm'),
				action: 'campaign.lines_written',
				entityType: 'campaign',
				entityId: campaignId,
				result: { eligible, llmRejected: rejected },
			})
		})
	}
}

async function currentCard(executor: Executor, cardId: number) {
	const [card] = await executor.select().from(cards).where(eq(cards.id, cardId))
	if (!card) throw new DomainError('Card not found.', 404)
	return card
}

function requireLead(actor: UserActor, action: string) {
	if (actor.role !== 'lead') throw new DomainError(`Only a sales lead can ${action}.`, 403)
}

async function approveWhere(
	tx: Tx,
	where: ReturnType<typeof and>,
	actor: UserActor,
	now: Date,
	requestId: string | undefined,
	bulk: boolean,
) {
	const approved = await tx
		.update(cards)
		.set({
			status: 'approved',
			approvedBy: actor.id,
			approvedByRole: 'lead',
			approvedAt: now,
			idempotencyKey: sql`gen_random_uuid()::text`,
			statusChangedAt: now,
		})
		.where(and(where, eq(cards.status, 'draft'), eq(cards.eligibility, 'eligible'), isNotNull(cards.personalLine)))
		.returning()
	for (const card of approved) {
		await audit(tx, {
			actor,
			action: 'card.approved',
			entityType: 'card',
			entityId: card.id,
			decision: 'approved',
			before: { status: 'draft' },
			after: { status: 'approved' },
			result: { idempotencyKey: card.idempotencyKey, ...(bulk && { bulk: true }) },
			requestId,
		})
	}
	return approved
}

// Conditional update: a second click finds the card no longer in draft, changes nothing and writes no audit event.
// A card whose line is not written yet is refused here, and by the database too (cards_line_present).
export async function approveCard(deps: CampaignDeps, input: { cardId: number; actor: UserActor; requestId?: string }) {
	requireLead(input.actor, 'approve cards')
	return deps.db.transaction(async (tx) => {
		const [card] = await approveWhere(tx, eq(cards.id, input.cardId), input.actor, deps.clock(), input.requestId, false)
		if (card) return { changed: true, card }
		const current = await currentCard(tx, input.cardId)
		if (current.status === 'draft' && current.eligibility === 'eligible' && current.personalLine === null)
			throw new DomainError('The personal line is still being written. Approve this card once it is there.', 409)
		return { changed: false, card: current }
	})
}

export async function approveEligible(
	deps: CampaignDeps,
	input: { campaignId: number; actor: UserActor; requestId?: string },
) {
	requireLead(input.actor, 'approve cards')
	return deps.db.transaction(async (tx) => {
		const approved = await approveWhere(
			tx,
			eq(cards.campaignId, input.campaignId),
			input.actor,
			deps.clock(),
			input.requestId,
			true,
		)
		return { approved: approved.length }
	})
}

// Only the draft, eligible cards among the chosen ones change; ids from another campaign match nothing.
export async function approveCards(
	deps: CampaignDeps,
	input: { campaignId: number; cardIds: number[]; actor: UserActor; requestId?: string },
) {
	requireLead(input.actor, 'approve cards')
	const cardIds = [...new Set(input.cardIds)]
	return deps.db.transaction(async (tx) => {
		const approved = await approveWhere(
			tx,
			and(eq(cards.campaignId, input.campaignId), inArray(cards.id, cardIds)),
			input.actor,
			deps.clock(),
			input.requestId,
			cardIds.length > 1,
		)
		return { approved: approved.length }
	})
}

async function rejectWhere(
	tx: Tx,
	where: ReturnType<typeof and>,
	input: { reason: string; actor: UserActor; requestId?: string },
	now: Date,
	bulk: boolean,
) {
	const rejected = await tx
		.update(cards)
		.set({ status: 'rejected', rejectReason: input.reason, statusChangedAt: now })
		.where(and(where, eq(cards.status, 'draft')))
		.returning()
	for (const card of rejected) {
		await audit(tx, {
			actor: input.actor,
			action: 'card.rejected',
			entityType: 'card',
			entityId: card.id,
			decision: 'rejected',
			reason: input.reason,
			before: { status: 'draft' },
			after: { status: 'rejected' },
			result: bulk ? { bulk: true } : undefined,
			requestId: input.requestId,
		})
	}
	return rejected
}

function requireReason(reason: string) {
	const trimmed = reason.trim()
	if (!trimmed) throw new DomainError('Please give a reason for rejecting. It is saved in the audit log.')
	return trimmed
}

export async function rejectCard(
	deps: CampaignDeps,
	input: { cardId: number; reason: string; actor: UserActor; requestId?: string },
) {
	const reason = requireReason(input.reason)
	return deps.db.transaction(async (tx) => {
		const [card] = await rejectWhere(tx, eq(cards.id, input.cardId), { ...input, reason }, deps.clock(), false)
		return card ? { changed: true, card } : { changed: false, card: await currentCard(tx, input.cardId) }
	})
}

// Same rules as rejectCard: only draft cards of this campaign change.
export async function rejectCards(
	deps: CampaignDeps,
	input: { campaignId: number; cardIds: number[]; reason: string; actor: UserActor; requestId?: string },
) {
	const reason = requireReason(input.reason)
	const cardIds = [...new Set(input.cardIds)]
	return deps.db.transaction(async (tx) => {
		const rejected = await rejectWhere(
			tx,
			and(eq(cards.campaignId, input.campaignId), inArray(cards.id, cardIds)),
			{ ...input, reason },
			deps.clock(),
			cardIds.length > 1,
		)
		return { rejected: rejected.length }
	})
}

// A person rewrites the line. Whatever was approved is no longer what will print, so the approval is cleared.
export async function editLine(
	deps: CampaignDeps,
	input: { cardId: number; text: string; actor: UserActor; requestId?: string },
) {
	const text = input.text.trim()
	if (!text) throw new DomainError('The line cannot be empty.')
	if (text.length > LINE_MAX_CHARS)
		throw new DomainError(`Keep the line under ${LINE_MAX_CHARS} characters (it is ${text.length}).`)
	const contact = contactDataIn(text)
	if (contact.length)
		throw new DomainError(`The line contains ${contact.join(' and ')}. Postcards never carry contact details.`)

	const now = deps.clock()
	return deps.db.transaction(async (tx) => {
		const before = await currentCard(tx, input.cardId)
		const [card] = await tx
			.update(cards)
			.set({
				personalLine: text,
				lineSource: 'human',
				status: 'draft',
				approvedBy: null,
				approvedByRole: null,
				approvedAt: null,
				idempotencyKey: null,
				statusChangedAt: now,
			})
			.where(and(eq(cards.id, input.cardId), inArray(cards.status, ['draft', 'approved'])))
			.returning()
		if (!card) throw new DomainError('This card is no longer a draft or approved, so its line cannot change.', 409)
		await audit(tx, {
			actor: input.actor,
			action: 'card.line_edited',
			entityType: 'card',
			entityId: card.id,
			before: { status: before.status, personalLine: before.personalLine },
			after: { status: 'draft', personalLine: text },
			result: { approvalReset: before.status === 'approved' },
			requestId: input.requestId,
		})
		return { card }
	})
}

// Every card ever built for this person, whatever company record they sit under now.
export function outreachHistory(executor: Executor, personKey: string) {
	return executor
		.select({
			cardId: cards.id,
			campaignId: campaigns.id,
			campaignName: campaigns.name,
			status: cards.status,
			submittedAt: cards.submittedAt,
			mailedAt: cards.mailedAt,
		})
		.from(cards)
		.innerJoin(campaigns, eq(cards.campaignId, campaigns.id))
		.where(and(eq(cards.personKey, personKey), isNotNull(cards.submittedAt)))
		.orderBy(desc(cards.submittedAt))
}
