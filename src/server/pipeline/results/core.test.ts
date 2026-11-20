import { describe, expect, it } from 'vitest'
import { attribute, summarise, type AttributionCard, type OutcomeEvent } from './core.ts'

const day = (n: number) => new Date(Date.UTC(2026, 6, 1 + n, 12))
const card = (overrides: Partial<AttributionCard>): AttributionCard => ({
	id: 1,
	variant: 'A',
	domain: 'ashdown.co.uk',
	personKey: 'laura@ashdown.co.uk',
	status: 'delivered',
	submittedAt: day(-2),
	mailedAt: day(0),
	...overrides,
})
const event = (overrides: Partial<OutcomeEvent>): OutcomeEvent => ({
	id: 1,
	kind: 'visit',
	domain: 'ashdown.co.uk',
	personKey: null,
	occurredAt: day(5),
	...overrides,
})

describe('attribute', () => {
	it('credits an event inside [mailed_at, mailed_at + 30 days], by domain or by person', () => {
		const cards = [card({})]
		expect(attribute(cards, [event({ occurredAt: day(0) })])[0]).toMatchObject({ cardId: 1 })
		expect(attribute(cards, [event({ occurredAt: day(30) })])[0]).toMatchObject({ cardId: 1 })
		expect(
			attribute(cards, [event({ kind: 'reply', domain: 'gmail.com', personKey: 'laura@ashdown.co.uk' })])[0],
		).toMatchObject({ cardId: 1 })
	})

	it('does not credit an event on day 35, before the card was mailed, or for another company', () => {
		const cards = [card({})]
		expect(attribute(cards, [event({ occurredAt: day(35) })])[0]).toMatchObject({ cardId: null, nearMiss: 1 })
		expect(attribute(cards, [event({ occurredAt: day(-1) })])[0]).toMatchObject({ cardId: null })
		expect(attribute(cards, [event({ domain: 'other.co.uk' })])[0]).toMatchObject({ cardId: null, nearMiss: null })
	})

	it('never credits a card that was not mailed', () => {
		expect(attribute([card({ mailedAt: null, status: 'submitted' })], [event({})])[0]?.cardId).toBeNull()
	})

	it('prefers the most recent mailing when two windows match', () => {
		const cards = [card({ id: 1, mailedAt: day(0) }), card({ id: 2, personKey: 'x@ashdown.co.uk', mailedAt: day(10) })]
		expect(attribute(cards, [event({ occurredAt: day(12) })])[0]?.cardId).toBe(2)
	})
})

describe('summarise', () => {
	it('counts per variant with decimal rates per card sent', () => {
		const cards = [
			card({ id: 1 }),
			card({ id: 2, variant: 'B', domain: 'b.co.uk', personKey: 'b@b.co.uk', status: 'returned' }),
			card({ id: 3, variant: 'A', domain: 'c.co.uk', personKey: 'c@c.co.uk' }),
		]
		const events = [
			event({ id: 1 }),
			event({ id: 2, kind: 'reply', domain: 'c.co.uk', personKey: 'c@c.co.uk' }),
			event({ id: 3, kind: 'meeting', domain: 'c.co.uk' }),
		]
		const summary = summarise(cards, attribute(cards, events), events)
		expect(summary.byVariant.A).toMatchObject({
			sent: 2,
			delivered: 2,
			returned: 0,
			replies: 1,
			visits: 1,
			meetings: 1,
			replyRate: '50',
			meetingRate: '50',
		})
		expect(summary.byVariant.B).toMatchObject({ sent: 1, delivered: 0, returned: 1, replies: 0, replyRate: '0' })
		expect(summary.tooSmallToConclude).toBe(true)
	})
})
