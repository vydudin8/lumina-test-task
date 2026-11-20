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

export const ingestionRuns = pgTable(
	'ingestion_runs',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		provider: text().notNull(),
		triggeredBy: text().notNull(),
		status: text().notNull().default('running'),
		startedAt: timestamp({ withTimezone: true }).notNull(),
		finishedAt: timestamp({ withTimezone: true }),
		recordsReceived: integer().notNull().default(0),
		recordsNew: integer().notNull().default(0),
		recordsUnchanged: integer().notNull().default(0),
		recordsRejected: integer().notNull().default(0),
		creditsUsed: numeric().notNull().default('0'),
		errors: jsonb().$type<IngestionError[]>().notNull().default([]),
	},
	(t) => [
		check('ingestion_runs_status', sql`${t.status} IN ('running', 'succeeded', 'succeeded_with_errors', 'failed')`),
		check('ingestion_runs_provider', sql`${t.provider} IN ('apollo', 'factset', 'clay')`),
		index('ingestion_runs_provider_started').on(t.provider, t.startedAt),
	],
)

export interface IngestionError {
	kind: 'company' | 'contact' | 'fundamental' | 'request'
	externalId: string | null
	problem: string
	payload?: unknown
}

// One row per distinct version of a provider record. A re-pull of unchanged data only moves last_seen_*.
export const rawRecords = pgTable(
	'raw_records',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		runId: integer()
			.notNull()
			.references(() => ingestionRuns.id),
		lastSeenRunId: integer()
			.notNull()
			.references(() => ingestionRuns.id),
		provider: text().notNull(),
		kind: text().notNull(),
		externalId: text().notNull(),
		payload: jsonb().$type<Record<string, unknown>>().notNull(),
		contentHash: text().notNull(),
		fetchedAt: timestamp({ withTimezone: true }).notNull(),
		lastSeenAt: timestamp({ withTimezone: true }).notNull(),
	},
	(t) => [
		unique('raw_records_version').on(t.provider, t.kind, t.externalId, t.contentHash),
		check('raw_records_kind', sql`${t.kind} IN ('company', 'contact')`),
		index('raw_records_latest').on(t.provider, t.kind, t.externalId, t.fetchedAt),
	],
)
