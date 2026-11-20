import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { audit, systemActor } from './audit.ts'
import { auditEvents, users } from './db/schema.ts'
import { useTestDb } from './test/db.ts'

const lead = { id: 'usr_lead_test', role: 'lead' } as const

describe('audit', () => {
	const t = useTestDb()

	it('appends an event with actor, decision, reason, diff and result', async () => {
		await audit(t.db, {
			actor: lead,
			action: 'card.rejected',
			entityType: 'card',
			entityId: 42,
			decision: 'rejected',
			reason: 'Wrong person',
			before: { status: 'draft' },
			after: { status: 'rejected' },
			result: { ok: true },
			requestId: 'req-1',
		})

		const [row] = await t.db.select().from(auditEvents).where(eq(auditEvents.requestId, 'req-1'))
		expect(row).toMatchObject({
			actorId: 'usr_lead_test',
			actorRole: 'lead',
			action: 'card.rejected',
			entityType: 'card',
			entityId: '42',
			decision: 'rejected',
			reason: 'Wrong person',
			before: { status: 'draft' },
			after: { status: 'rejected' },
			result: { ok: true },
		})
		expect(row?.at).toBeInstanceOf(Date)
	})

	it.each([
		['UPDATE', sql`UPDATE audit_events SET reason = 'edited'`],
		['DELETE', sql`DELETE FROM audit_events`],
		['TRUNCATE', sql`TRUNCATE audit_events`],
	])('rejects %s: the table is append-only', async (_op, statement) => {
		await audit(t.db, {
			actor: systemActor('test'),
			action: 'suppression.added',
			entityType: 'suppression',
			entityId: 1,
		})
		await expect(t.db.execute(statement)).rejects.toMatchObject({ cause: { message: /append-only/ } })
	})

	it('rolls back the state change when the audit write fails', async () => {
		const failing = t.db.transaction(async (tx) => {
			await tx.insert(users).values({ id: 'usr_rollback', name: 'Rolled Back', role: 'rep' })
			await audit(tx, { actor: lead, action: 'card.rejected', entityType: 'card', entityId: 1, decision: 'rejected' })
		})

		await expect(failing).rejects.toThrow()
		expect(await t.db.select().from(users).where(eq(users.id, 'usr_rollback'))).toEqual([])
	})

	it.each([
		['a rejection', { action: 'card.rejected', decision: 'rejected' }],
		['a manual merge', { action: 'company.merged' }],
		['an unmerge', { action: 'company.unmerged' }],
		['a field override', { action: 'field.overridden', decision: 'overridden' }],
	] as const)('requires a reason for %s in the database', async (_label, event) => {
		const insert = t.db.insert(auditEvents).values({
			actorId: lead.id,
			actorRole: lead.role,
			entityType: 'x',
			entityId: '1',
			reason: '  ',
			...event,
		})
		await expect(insert).rejects.toMatchObject({ cause: { constraint: 'audit_reason_required' } })
	})

	it('only accepts system:<component> ids for the system role', async () => {
		const forged = t.db
			.insert(auditEvents)
			.values({ actorId: 'usr_rep', actorRole: 'system', action: 'card.submitted', entityType: 'card', entityId: '1' })
		await expect(forged).rejects.toMatchObject({ cause: { constraint: 'audit_actor' } })
	})
})
