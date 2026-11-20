import { sql } from 'drizzle-orm'
import {
	bigint,
	check,
	date,
	index,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	text,
	timestamp,
	unique,
} from 'drizzle-orm/pg-core'

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

// GBP per one unit of `currency`, as published on `as_of`. Rates are seeded, not live.
export const fxRates = pgTable(
	'fx_rates',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		currency: text().notNull(),
		rate: numeric().notNull(),
		asOf: date().notNull(),
	},
	(t) => [unique('fx_rates_currency_as_of').on(t.currency, t.asOf), check('fx_rates_positive', sql`${t.rate} > 0`)],
)

// Immutable (trigger): saving the ICP always creates a new version.
export const icpVersions = pgTable('icp_versions', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	rules: jsonb().notNull(),
	createdBy: text()
		.notNull()
		.references(() => users.id),
	createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

export const templates = pgTable(
	'templates',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		name: text().notNull().unique(),
		variant: text().notNull(),
		body: text().notNull(),
	},
	(t) => [check('templates_variant', sql`${t.variant} IN ('A', 'B')`)],
)

// Only a hash of the normalised email is kept, so an opt-out outlives the contact record it came from.
export const suppressions = pgTable(
	'suppressions',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		personKeyHash: text().notNull().unique(),
		reason: text().notNull(),
		source: text(),
		createdBy: text().notNull(),
		at: timestamp({ withTimezone: true }).notNull(),
	},
	(t) => [check('suppressions_hash', sql`${t.personKeyHash} ~ '^[0-9a-f]{64}$'`)],
)

export const seedRuns = pgTable('seed_runs', {
	version: integer().primaryKey(),
	checksum: text().notNull(),
	at: timestamp({ withTimezone: true }).notNull(),
})
