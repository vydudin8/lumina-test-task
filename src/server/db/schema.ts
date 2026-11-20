import { sql } from 'drizzle-orm'
import { bigint, check, index, jsonb, pgEnum, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core'

export const userRole = pgEnum('user_role', ['rep', 'lead'])

export const users = pgTable(
	'users',
	{ id: text().primaryKey(), name: text().notNull(), role: userRole().notNull() },
	(t) => [
		// Target of the (approved_by, approved_by_role) FK on cards: the database itself knows who is a lead.
		unique('users_id_role').on(t.id, t.role),
	],
)

export const auditEvents = pgTable(
	'audit_events',
	{
		id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		at: timestamp({ withTimezone: true }).notNull().defaultNow(),
		actorId: text().notNull(),
		actorRole: text().notNull(),
		action: text().notNull(),
		entityType: text().notNull(),
		entityId: text().notNull(),
		decision: text(),
		reason: text(),
		before: jsonb(),
		after: jsonb(),
		result: jsonb(),
		requestId: text(),
	},
	(t) => [
		check(
			'audit_actor',
			sql`${t.actorRole} IN ('rep', 'lead', 'system') AND (${t.actorRole} = 'system') = (${t.actorId} LIKE 'system:%')`,
		),
		check('audit_decision', sql`${t.decision} IN ('approved', 'rejected', 'overridden', 'blocked')`),
		check(
			'audit_reason_required',
			sql`(${t.decision} IS DISTINCT FROM 'rejected' AND ${t.action} NOT IN ('company.merged', 'company.unmerged', 'field.overridden')) OR btrim(coalesce(${t.reason}, '')) <> ''`,
		),
		index('audit_events_entity').on(t.entityType, t.entityId, t.at),
		index('audit_events_at').on(t.at),
	],
)
