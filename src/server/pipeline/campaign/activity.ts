import type { auditEvents } from '../../db/schema.ts'

export type ActivityEvent = typeof auditEvents.$inferSelect

export interface ActivityGroup {
	// The newest event's id: stable while older events join the group.
	id: string
	action: string
	actorId: string
	actorRole: string
	at: Date
	firstAt: Date
	count: number
	cardIds: number[]
	events: ActivityEvent[]
}

const JOIN_WINDOW_MS = 10 * 60 * 1000

// Events must come newest first. A bulk action shares one request id; worker events carry none, so they group by
// action and actor alone, as long as each one lands within the window of the group's oldest event so far.
export function groupActivity(events: ActivityEvent[]): ActivityGroup[] {
	const groups: ActivityGroup[] = []
	const open = new Map<string, ActivityGroup>()
	for (const event of events) {
		const key = [event.action, event.actorId, event.requestId ?? ''].join('\0')
		let group = open.get(key)
		if (group && group.firstAt.getTime() - event.at.getTime() > JOIN_WINDOW_MS) group = undefined
		if (!group) {
			group = {
				id: String(event.id),
				action: event.action,
				actorId: event.actorId,
				actorRole: event.actorRole,
				at: event.at,
				firstAt: event.at,
				count: 0,
				cardIds: [],
				events: [],
			}
			groups.push(group)
			open.set(key, group)
		}
		group.firstAt = event.at
		group.count++
		if (event.entityType === 'card') group.cardIds.push(Number(event.entityId))
		group.events.push(event)
	}
	return groups
}
