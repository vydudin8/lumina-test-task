import type { Executor } from './db/client.ts'
import { auditEvents } from './db/schema.ts'

export type Actor = { id: string; role: 'rep' | 'lead' } | { id: `system:${string}`; role: 'system' }

export type AuditAction =
	| 'icp.saved'
	| 'company.merged'
	| 'company.unmerged'
	| 'field.overridden'
	| 'card.line_edited'
	| 'card.approved'
	| 'card.rejected'
	| 'card.blocked_at_send'
	| 'card.submitted'
	| 'card.failed'
	| 'campaign.created'
	| 'campaign.send_launched'
	| 'suppression.added'
	| 'outcome.logged'
	| 'llm.output_rejected'

export interface AuditEvent {
	actor: Actor
	action: AuditAction
	entityType: string
	entityId: string | number
	decision?: 'approved' | 'rejected' | 'overridden' | 'blocked'
	reason?: string
	before?: unknown
	after?: unknown
	result?: unknown
	requestId?: string
}

export const systemActor = (component: string): Actor => ({ id: `system:${component}` as const, role: 'system' })

// Pass the transaction that makes the state change: if this insert fails, the change rolls back with it.
export async function audit(executor: Executor, event: AuditEvent) {
	await executor.insert(auditEvents).values({
		actorId: event.actor.id,
		actorRole: event.actor.role,
		action: event.action,
		entityType: event.entityType,
		entityId: String(event.entityId),
		decision: event.decision,
		reason: event.reason,
		before: event.before,
		after: event.after,
		result: event.result,
		requestId: event.requestId,
	})
}
