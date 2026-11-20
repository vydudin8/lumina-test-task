import { and, eq, isNotNull } from 'drizzle-orm'
import { audit } from '../../audit.ts'
import type { Db, Executor } from '../../db/client.ts'
import { cards, outcomeEvents } from '../../db/schema.ts'
import type { Clock } from '../../lib/clock.ts'
import { DomainError } from '../../lib/errors.ts'
import { loadMaster } from '../resolve/store.ts'
import { attribute, summarise, type AttributionCard, type OutcomeEvent } from './core.ts'

type UserActor = { id: string; role: 'rep' | 'lead' }
const DAY_MS = 86_400_000

// Attribution looks at every mailed card in every campaign, so an event lands on the mailing it belongs to.
export async function campaignResults(executor: Executor, campaignId: number, now: Date) {
	const domains = new Map(
		(await loadMaster(executor, now)).companies.map((company) => [company.id, company.fields.domain.value]),
	)
	const mailed = await executor.select().from(cards).where(isNotNull(cards.submittedAt))
	const toAttribution = (card: (typeof mailed)[number]): AttributionCard => ({
		id: card.id,
		variant: card.variant,
		domain: domains.get(card.companyId) ?? null,
		personKey: card.personKey,
		status: card.status,
		submittedAt: card.submittedAt,
		mailedAt: card.mailedAt,
	})
	const allCards = mailed.map(toAttribution)
	const events: OutcomeEvent[] = (await executor.select().from(outcomeEvents)).map((event) => ({
		id: event.id,
		kind: event.kind,
		domain: event.domain,
		personKey: event.personKey,
		occurredAt: event.occurredAt,
	}))
	const attributions = attribute(allCards, events)

	const ours = new Set(mailed.filter((card) => card.campaignId === campaignId).map((card) => card.id))
	const campaignCards = allCards.filter((card) => ours.has(card.id))
	const relevant = attributions.filter(
		(a) =>
			(a.cardId !== null && ours.has(a.cardId)) || (a.cardId === null && a.nearMiss !== null && ours.has(a.nearMiss)),
	)
	const byId = new Map(events.map((event) => [event.id, event]))
	const cardById = new Map(allCards.map((card) => [card.id, card]))

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
			.select()
			.from(cards)
			.where(and(eq(cards.id, input.cardId), isNotNull(cards.mailedAt)))
		if (!card) throw new DomainError('Only a card that was mailed can have outcomes.', 409)
		const domain =
			(await loadMaster(tx, now)).companies.find((company) => company.id === card.companyId)?.fields.domain.value ??
			null
		const [event] = await tx
			.insert(outcomeEvents)
			.values({
				kind: input.kind,
				domain,
				personKey: card.personKey,
				occurredAt: input.occurredAt,
				source: 'logged by hand',
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
