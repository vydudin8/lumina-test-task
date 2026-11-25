import { describe, expect, it } from 'vitest'
import { groupActivity, type ActivityEvent } from './activity.ts'

const T0 = Date.UTC(2026, 10, 20, 12)
const SECOND = 1000
const MINUTE = 60 * SECOND

let nextId = 1000
// Events are built newest first: pass `ago` in ms before T0 and keep the calls in that order.
const event = (ago: number, overrides: Partial<ActivityEvent> = {}): ActivityEvent => ({
	id: nextId--,
	at: new Date(T0 - ago),
	actorId: 'usr_lead_maya',
	actorRole: 'lead',
	action: 'card.approved',
	entityType: 'card',
	entityId: '1',
	decision: null,
	reason: null,
	before: null,
	after: null,
	result: null,
	requestId: null,
	...overrides,
})

describe('groupActivity', () => {
	it('puts a bulk approval with one request id into one group, with the card ids in event order', () => {
		const events = [3, 2, 1].map((id, index) => event(index * 5, { entityId: String(id), requestId: 'req-1' }))
		const groups = groupActivity(events)
		expect(groups).toHaveLength(1)
		expect(groups[0]).toMatchObject({
			id: String(events[0]!.id),
			action: 'card.approved',
			actorId: 'usr_lead_maya',
			actorRole: 'lead',
			count: 3,
			cardIds: [3, 2, 1],
			at: events[0]!.at,
			firstAt: events[2]!.at,
		})
		expect(groups[0]!.events).toEqual(events)
	})

	it('groups worker events that have no request id by action, even when other events sit between them', () => {
		const worker = { actorId: 'system:send', actorRole: 'system' }
		const events: ActivityEvent[] = []
		for (let i = 0; i < 47; i++) {
			const blocked = i === 10 || i === 30
			events.push(
				event(i * 3 * SECOND, {
					...worker,
					action: blocked ? 'card.blocked_at_send' : 'card.submitted',
					entityId: String(i),
				}),
			)
		}
		const groups = groupActivity(events)
		expect(groups.map((group) => [group.action, group.count])).toEqual([
			['card.submitted', 45],
			['card.blocked_at_send', 2],
		])
		// Ordered by newest event: the submitted group opened first.
		expect(groups[0]!.at.getTime()).toBeGreaterThan(groups[1]!.at.getTime())
	})

	it('keeps two manual approvals with different request ids as two groups', () => {
		const groups = groupActivity([
			event(0, { entityId: '2', requestId: 'req-2' }),
			event(30 * SECOND, { entityId: '1', requestId: 'req-1' }),
		])
		expect(groups.map((group) => group.cardIds)).toEqual([[2], [1]])
	})

	it('splits the same key when the gap to the group is over 10 minutes, and joins it at exactly 10', () => {
		const split = groupActivity([event(0, { requestId: 'r' }), event(11 * MINUTE, { requestId: 'r' })])
		expect(split.map((group) => group.count)).toEqual([1, 1])
		const joined = groupActivity([event(0, { requestId: 'r' }), event(10 * MINUTE, { requestId: 'r' })])
		expect(joined.map((group) => group.count)).toEqual([2])
	})

	it('does not list a campaign event as a card id, and keeps different actors apart', () => {
		const groups = groupActivity([
			event(0, { entityType: 'campaign', entityId: '7', action: 'campaign.created' }),
			event(SECOND, { actorId: 'usr_rep_tom', actorRole: 'rep', requestId: null }),
			event(2 * SECOND, { requestId: null }),
		])
		expect(groups.map((group) => [group.actorId, group.cardIds])).toEqual([
			['usr_lead_maya', []],
			['usr_rep_tom', [1]],
			['usr_lead_maya', [1]],
		])
	})
})
