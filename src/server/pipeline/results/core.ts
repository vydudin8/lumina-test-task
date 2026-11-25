import { ATTRIBUTION_WINDOW_DAYS, MIN_SAMPLE_PER_VARIANT } from '#common/settings.ts'
import Decimal from 'decimal.js'

export interface AttributionCard {
	id: number
	variant: 'A' | 'B' | null
	// Every domain of the company the card belongs to now: a merged company can have one per office.
	domains: string[]
	personKey: string
	status: string
	submittedAt: Date | null
	mailedAt: Date | null
}

export interface OutcomeEvent {
	id: number
	kind: 'reply' | 'visit' | 'meeting'
	domain: string | null
	personKey: string | null
	occurredAt: Date
}

export interface Attribution {
	eventId: number
	cardId: number | null
	// A card the event matched whose window had already closed: shown so the exclusion is visible, never counted.
	nearMiss: number | null
}

const WINDOW_MS = ATTRIBUTION_WINDOW_DAYS * 86_400_000

// An event belongs to a card when a domain of the company or the person matches and it happened within
// [mailed_at, mailed_at + 30 days]. Cards never mailed get nothing. The 90-day hold makes one person's windows disjoint.
export function attribute(cards: AttributionCard[], events: OutcomeEvent[]): Attribution[] {
	const mailed = cards.filter((card) => card.mailedAt !== null)
	return events.map((event) => {
		const matching = mailed
			.filter(
				(card) =>
					(event.domain !== null && card.domains.includes(event.domain)) ||
					(event.personKey !== null && card.personKey === event.personKey),
			)
			.filter((card) => card.mailedAt!.getTime() <= event.occurredAt.getTime())
			.sort((a, b) => b.mailedAt!.getTime() - a.mailedAt!.getTime() || a.id - b.id)
		const inWindow = matching.find((card) => event.occurredAt.getTime() - card.mailedAt!.getTime() <= WINDOW_MS)
		return { eventId: event.id, cardId: inWindow?.id ?? null, nearMiss: inWindow ? null : (matching[0]?.id ?? null) }
	})
}

const rate = (count: number, sent: number) =>
	sent === 0 ? null : new Decimal(count).div(sent).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toString()

export { MIN_SAMPLE_PER_VARIANT }

export function summarise(cards: AttributionCard[], attributions: Attribution[], events: OutcomeEvent[]) {
	const kindOf = new Map(events.map((event) => [event.id, event.kind]))
	const variant = (name: 'A' | 'B') => {
		const arm = cards.filter((card) => card.variant === name && card.submittedAt !== null)
		const ids = new Set(arm.map((card) => card.id))
		// Cards with at least one such event, not events: a company that replies twice or visits ten times is one
		// response, so a rate is the share of cards that worked and never passes 100%.
		const credited = (kind: OutcomeEvent['kind']) =>
			new Set(
				attributions
					.filter((a) => a.cardId !== null && ids.has(a.cardId) && kindOf.get(a.eventId) === kind)
					.map((a) => a.cardId),
			).size
		const sent = arm.length
		const [replies, visits, meetings] = [credited('reply'), credited('visit'), credited('meeting')]
		return {
			sent,
			delivered: arm.filter((card) => card.status === 'delivered').length,
			returned: arm.filter((card) => card.status === 'returned').length,
			replies,
			visits,
			meetings,
			replyRate: rate(replies, sent),
			visitRate: rate(visits, sent),
			meetingRate: rate(meetings, sent),
		}
	}
	const byVariant = { A: variant('A'), B: variant('B') }
	return {
		byVariant,
		outsideWindow: attributions.filter((a) => a.cardId === null && a.nearMiss !== null).length,
		tooSmallToConclude: byVariant.A.sent < MIN_SAMPLE_PER_VARIANT || byVariant.B.sent < MIN_SAMPLE_PER_VARIANT,
	}
}
