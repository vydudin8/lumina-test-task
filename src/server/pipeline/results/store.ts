import { and, eq, getTableColumns, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm'
import { audit } from '../../audit.ts'
import type { Db, Executor } from '../../db/client.ts'
import { cards, companies, outcomeEvents, sourceCompanies } from '../../db/schema.ts'
import type { Clock } from '../../lib/clock.ts'
import { DomainError } from '../../lib/errors.ts'
import { cardCompany, companyDomains, companyLabels } from '../resolve/store.ts'
import { attribute, summarise, type AttributionCard, type OutcomeEvent } from './core.ts'

type UserActor = { id: string; role: 'rep' | 'lead' }
const DAY_MS = 86_400_000

const attributionColumns = {
	id: cards.id,
	// The company the card belongs to now, so merges and splits since it was mailed move its results along with it.
	companyId: cardCompany,
	variant: cards.variant,
	personKey: cards.personKey,
	status: cards.status,
	submittedAt: cards.submittedAt,
	mailedAt: cards.mailedAt,
}

// An event lands on the latest mailing of its company or person before it, in any campaign, so this campaign's
// numbers need only the events that touch what it mailed, and the mailings those events could belong to instead.
export async function campaignResults(executor: Executor, campaignId: number) {
	const labels = new Map<number, { name: string | null; domain: string | null }>()
	const domains = new Map<number, string[]>()
	const label = async (companyIds: number[]) => {
		for (const [id, row] of await companyLabels(executor, companyIds)) labels.set(id, row)
		for (const [id, list] of await companyDomains(executor, companyIds)) domains.set(id, list)
	}
	const toAttribution = (card: Pick<typeof cards.$inferSelect, keyof typeof attributionColumns>): AttributionCard => ({
		id: card.id,
		variant: card.variant,
		domains: domains.get(card.companyId) ?? [],
		// Mailed cards always have a recipient (cards_recipient_present).
		personKey: card.personKey!,
		status: card.status,
		submittedAt: card.submittedAt,
		mailedAt: card.mailedAt,
	})
	const mailed = await executor
		.select(attributionColumns)
		.from(cards)
		.where(and(eq(cards.campaignId, campaignId), isNotNull(cards.submittedAt)))
	await label(mailed.map((card) => card.companyId))
	const campaignCards = mailed.map(toAttribution)

	const sent = campaignCards.filter((card) => card.mailedAt !== null)
	const events: OutcomeEvent[] = sent.length
		? (
				await executor
					.select()
					.from(outcomeEvents)
					.where(
						and(
							// Nothing counts for a card before it was mailed.
							gte(outcomeEvents.occurredAt, new Date(Math.min(...sent.map((card) => card.mailedAt!.getTime())))),
							or(
								inArray(outcomeEvents.domain, [...new Set(sent.flatMap((card) => card.domains))]),
								inArray(outcomeEvents.personKey, [...new Set(sent.map((card) => card.personKey))]),
							),
						),
					)
					.orderBy(outcomeEvents.id)
			).map((event) => ({
				id: event.id,
				kind: event.kind,
				domain: event.domain,
				personKey: event.personKey,
				occurredAt: event.occurredAt,
			}))
		: []

	// Every mailing, in any campaign, to the companies or people those events name.
	const eventDomains = new Set(events.flatMap((event) => event.domain ?? []))
	const eventPeople = [...new Set(events.flatMap((event) => event.personKey ?? []))]
	const named = executor
		.select({ id: sourceCompanies.companyId })
		.from(sourceCompanies)
		.where(inArray(sourceCompanies.normalisedDomain, [...eventDomains]))
	// cardCompany's rule, spelled out so the card indexes serve it: built from a record of those companies, or, with no
	// record, filed under one of them or under a number merged into one.
	const mailedThem = or(
		inArray(
			cards.sourceCompanyId,
			executor
				.select({ id: sourceCompanies.id })
				.from(sourceCompanies)
				.where(inArray(sourceCompanies.companyId, named)),
		),
		and(
			isNull(cards.sourceCompanyId),
			inArray(
				cards.companyId,
				executor
					.select({ id: companies.id })
					.from(companies)
					.where(or(inArray(companies.id, named), inArray(companies.mergedInto, named))),
			),
		),
	)
	const others = events.length
		? await executor
				.select(attributionColumns)
				.from(cards)
				.where(
					and(
						isNotNull(cards.submittedAt),
						isNotNull(cards.mailedAt),
						or(mailedThem, inArray(cards.personKey, eventPeople)),
					),
				)
		: []
	await label(others.map((card) => card.companyId).filter((id) => !labels.has(id)))
	const allCards = [
		...new Map([...campaignCards, ...others.map(toAttribution)].map((card) => [card.id, card])).values(),
	]
	const attributions = attribute(allCards, events)

	const ours = new Set(campaignCards.map((card) => card.id))
	const relevant = attributions.filter(
		(a) =>
			(a.cardId !== null && ours.has(a.cardId)) || (a.cardId === null && a.nearMiss !== null && ours.has(a.nearMiss)),
	)
	const byId = new Map(events.map((event) => [event.id, event]))
	const cardById = new Map(allCards.map((card) => [card.id, card]))
	// The campaign page holds one page of cards, so the results name the company themselves.
	const companyOfCard = new Map([...mailed, ...others].map((card) => [card.id, card.companyId]))

	return {
		summary: summarise(campaignCards, relevant, events),
		events: relevant.map((a) => {
			const event = byId.get(a.eventId)!
			const cardId = (a.cardId ?? a.nearMiss)!
			const mailedAt = cardById.get(cardId)!.mailedAt!
			return {
				eventId: event.id,
				kind: event.kind,
				occurredAt: event.occurredAt,
				cardId,
				companyName: labels.get(companyOfCard.get(cardId)!)?.name ?? null,
				variant: cardById.get(cardId)!.variant,
				counted: a.cardId !== null,
				daysAfterMailing: Math.floor((event.occurredAt.getTime() - mailedAt.getTime()) / DAY_MS),
			}
		}),
	}
}

// A person logs a reply or a meeting against a mailed card. Visits come only from the analytics feed.
export async function logOutcome(
	deps: { db: Db; clock: Clock },
	input: {
		cardId: number
		kind: 'reply' | 'meeting'
		occurredAt: Date
		note?: string
		idempotencyKey: string
		actor: UserActor
		requestId?: string
	},
) {
	const now = deps.clock()
	if (input.occurredAt.getTime() > now.getTime()) throw new DomainError('That date is in the future.')
	return deps.db.transaction(async (tx) => {
		const [existing] = await tx
			.select()
			.from(outcomeEvents)
			.where(eq(outcomeEvents.idempotencyKey, input.idempotencyKey))
		if (existing) return { created: false, event: existing }

		const [card] = await tx
			.select({ ...getTableColumns(cards), liveCompanyId: cardCompany })
			.from(cards)
			.where(and(eq(cards.id, input.cardId), isNotNull(cards.mailedAt)))
		if (!card) throw new DomainError('Only a card that was mailed can have outcomes.', 409)
		// Attribution starts at the mailing, so an earlier outcome would be saved but never count for this card.
		if (input.occurredAt.getTime() < card.mailedAt!.getTime())
			throw new DomainError('That date is before the card was mailed.')
		const domain = (await companyLabels(tx, [card.liveCompanyId])).get(card.liveCompanyId)?.domain ?? null
		const [event] = await tx
			.insert(outcomeEvents)
			.values({
				kind: input.kind,
				domain,
				personKey: card.personKey,
				occurredAt: input.occurredAt,
				source: 'logged manually',
				note: input.note?.trim() || null,
				idempotencyKey: input.idempotencyKey,
				createdBy: input.actor.id,
				createdAt: now,
			})
			.onConflictDoNothing({ target: outcomeEvents.idempotencyKey })
			.returning()
		if (!event)
			return {
				created: false,
				event: (
					await tx.select().from(outcomeEvents).where(eq(outcomeEvents.idempotencyKey, input.idempotencyKey))
				)[0]!,
			}
		await audit(tx, {
			actor: input.actor,
			action: 'outcome.logged',
			entityType: 'card',
			entityId: card.id,
			after: { kind: input.kind, occurredAt: input.occurredAt.toISOString() },
			result: { outcomeEventId: event.id },
			requestId: input.requestId,
		})
		return { created: true, event }
	})
}
