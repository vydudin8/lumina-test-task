import { and, desc, eq, inArray, isNotNull, max, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { audit, systemActor } from '../../audit.ts'
import type { Db, Executor, Tx } from '../../db/client.ts'
import { campaigns, cards, contacts, suppressions, templates } from '../../db/schema.ts'
import type { Clock } from '../../lib/clock.ts'
import { DomainError } from '../../lib/errors.ts'
import { generateGrounded, type GroundedLine, type LlmDeps } from '../../llm/generate.ts'
import { contactDataIn } from '../../llm/guard.ts'
import { chooseRecipient } from '../../policy/recipient.ts'
import type { SuppressionState } from '../../policy/suppression.ts'
import { loadMaster } from '../resolve/store.ts'
import { icpVersion, scoreCompanies } from '../score/store.ts'
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
export async function loadSuppressionState(executor: Executor): Promise<SuppressionState> {
	const optOuts = await executor.select({ hash: suppressions.personKeyHash }).from(suppressions)
	const sentAt = sql<Date>`coalesce(${cards.submittedAt}, CASE WHEN ${cards.status} = 'unconfirmed' THEN ${cards.statusChangedAt} END)`
	const submitted = await executor
		.select({ personKey: cards.personKey, last: max(sentAt) })
		.from(cards)
		.where(sql`${sentAt} IS NOT NULL`)
		.groupBy(cards.personKey)
	return {
		optOutHashes: new Set(optOuts.map((row) => row.hash)),
		lastSubmitted: new Map(submitted.map((row) => [row.personKey, new Date(row.last!)])),
	}
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>) {
	const results: R[] = []
	for (let i = 0; i < items.length; i += size) results.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
	return results
}

export interface CreateCampaignInput {
	idempotencyKey: string
	name: string
	topN: number
	templateAId: number
	templateBId: number
	icpVersionId?: number
	actor: UserActor
	requestId?: string
}

// Snapshots the ICP version, scores, recipients and addresses at build time. Safe to retry with the same key.
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

	const chosenTemplates = await deps.db
		.select()
		.from(templates)
		.where(inArray(templates.id, [input.templateAId, input.templateBId]))
	if (
		chosenTemplates.find((template) => template.id === input.templateAId)?.variant !== 'A' ||
		chosenTemplates.find((template) => template.id === input.templateBId)?.variant !== 'B'
	) {
		throw new DomainError('Pick an A template and a B template.')
	}

	const icp = await icpVersion(deps.db, input.icpVersionId)
	const { companies } = await loadMaster(deps.db, now)
	const top = scoreCompanies(companies, icp).ranked.slice(0, input.topN)
	if (top.length === 0) throw new DomainError('No company is in the profile, so there is nobody to mail.')

	const contactRows = await deps.db
		.select()
		.from(contacts)
		.where(
			inArray(
				contacts.id,
				top.flatMap((row) => row.company.contactIds),
			),
		)
	const suppression = await loadSuppressionState(deps.db)

	let variantIndex = 0
	const drafts = top.flatMap((row) => {
		const choice = chooseRecipient(
			contactRows
				.filter((contact) => row.company.contactIds.includes(contact.id))
				.map((contact) => ({ ...contact, fetchedAt: contact.fetchedAt.toISOString() })),
		)
		// A company with no listed person cannot get a card at all.
		if (!choice) return []
		const address = row.company.fields.address.value
		const blocked = blockReason(choice.chosen.personKey, address, suppression, now)
		const evidence = cardLineEvidence(choice.chosen, row.company)
		return [
			{
				row,
				choice,
				address,
				blocked,
				evidence,
				variant: blocked ? null : variantIndex++ % 2 === 0 ? ('A' as const) : ('B' as const),
			},
		]
	})

	const lines = await inBatches(drafts, LLM_CONCURRENCY, async (draft): Promise<GroundedLine | null> => {
		if (draft.blocked) return null
		return generateGrounded(
			deps,
			{
				task: 'card_line',
				purpose: `Write the opening line of a postcard to ${draft.choice.chosen.firstName ?? 'the recipient'} at ${draft.row.company.fields.name.value ?? 'their company'}.`,
				evidence: draft.evidence,
				maxChars: LINE_MAX_CHARS,
			},
			fallbackLine(draft.evidence),
		)
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
				drafts.map((draft, index) => {
					const line = lines[index]
					const fallback = fallbackLine(draft.evidence)
					const { chosen, candidates, decidedBy } = draft.choice
					return {
						campaignId: campaign.id,
						companyId: draft.row.company.id,
						contactId: chosen.contactId,
						personKey: chosen.personKey,
						rank: draft.row.rank,
						score: draft.row.score.score,
						scoreDisplay: draft.row.score.display,
						contributions: draft.row.score.contributions,
						recipient: {
							fullName: chosen.fullName,
							firstName: chosen.firstName,
							title: chosen.title,
							function: chosen.function,
							seniority: chosen.seniority,
							providers: chosen.providers,
							decidedBy,
							candidates,
						},
						address: draft.address as Record<string, string | null> | null,
						eligibility: draft.blocked ? ('blocked' as const) : ('eligible' as const),
						blockReason: draft.blocked,
						variant: draft.variant,
						personalLine: line?.text ?? fallback.text,
						lineSource: line?.status === 'accepted' ? ('llm' as const) : ('template' as const),
						lineCites: line?.cites ?? fallback.cites,
						lineEvidence: draft.evidence,
						llmStatus: line?.status ?? null,
						llmRejections: line?.rejections ?? [],
						llmRaw: line?.raw ?? null,
						llmModel: line?.model ?? null,
						promptVersion: line?.promptVersion ?? null,
						status: draft.blocked ? ('blocked' as const) : ('draft' as const),
						statusChangedAt: now,
						createdAt: now,
					}
				}),
			)
			.onConflictDoNothing()
			.returning()

		await audit(tx, {
			actor,
			action: 'campaign.created',
			entityType: 'campaign',
			entityId: campaign.id,
			after: { name: campaign.name, topN: campaign.topN, icpVersionId: icp.id },
			result: { cards: inserted.length, eligible: inserted.filter((card) => card.eligibility === 'eligible').length },
			requestId,
		})
		for (const card of inserted.filter((row) => row.llmStatus === 'rejected')) {
			await audit(tx, {
				actor: systemActor('llm'),
				action: 'llm.output_rejected',
				entityType: 'card',
				entityId: card.id,
				reason: card.llmRejections.map((rejection) => rejection.code).join(','),
				result: { task: 'card_line', rejections: card.llmRejections, model: card.llmModel },
				requestId,
			})
		}
		return { campaign, created: true }
	})
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
		.where(and(where, eq(cards.status, 'draft'), eq(cards.eligibility, 'eligible')))
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
export async function approveCard(deps: CampaignDeps, input: { cardId: number; actor: UserActor; requestId?: string }) {
	requireLead(input.actor, 'approve cards')
	return deps.db.transaction(async (tx) => {
		const [card] = await approveWhere(tx, eq(cards.id, input.cardId), input.actor, deps.clock(), input.requestId, false)
		return card ? { changed: true, card } : { changed: false, card: await currentCard(tx, input.cardId) }
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

export async function rejectCard(
	deps: CampaignDeps,
	input: { cardId: number; reason: string; actor: UserActor; requestId?: string },
) {
	const reason = input.reason.trim()
	if (!reason) throw new DomainError('Please give a reason for rejecting this card. It is saved in the audit log.')
	const now = deps.clock()
	return deps.db.transaction(async (tx) => {
		const [card] = await tx
			.update(cards)
			.set({ status: 'rejected', rejectReason: reason, statusChangedAt: now })
			.where(and(eq(cards.id, input.cardId), eq(cards.status, 'draft')))
			.returning()
		if (!card) return { changed: false, card: await currentCard(tx, input.cardId) }
		await audit(tx, {
			actor: input.actor,
			action: 'card.rejected',
			entityType: 'card',
			entityId: card.id,
			decision: 'rejected',
			reason,
			before: { status: 'draft' },
			after: { status: 'rejected' },
			requestId: input.requestId,
		})
		return { changed: true, card }
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
