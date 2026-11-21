import type { FieldName } from '#common/settings.ts'
import { sql } from 'drizzle-orm'
import {
	bigint,
	boolean,
	check,
	date,
	foreignKey,
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
import type { EvidenceItem, Rejection } from '../llm/types.ts'
import type { Candidate, DecidedBy } from '../policy/recipient.ts'

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

export const companies = pgTable('companies', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

// One normalised row per provider company record. company_id is the merge link; merge and unmerge only move it.
export const sourceCompanies = pgTable(
	'source_companies',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		provider: text().notNull(),
		externalId: text().notNull(),
		rawRecordId: integer()
			.notNull()
			.references(() => rawRecords.id),
		// Null only inside the resolution transaction, before clustering assigns it.
		companyId: integer().references(() => companies.id),
		fetchedAt: timestamp({ withTimezone: true }).notNull(),
		normalisedName: text(),
		normalisedDomain: text(),
		country: text(),
		fields: jsonb().$type<Record<string, unknown>>().notNull(),
		revenueAmount: numeric(),
		revenueCurrency: text(),
		revenueGbp: numeric(),
		fxRateId: integer().references(() => fxRates.id),
	},
	(t) => [
		unique('source_companies_record').on(t.provider, t.externalId),
		index('source_companies_company').on(t.companyId),
		check(
			'source_companies_revenue',
			sql`(${t.revenueAmount} IS NULL) = (${t.revenueGbp} IS NULL) AND (${t.revenueGbp} IS NULL) = (${t.fxRateId} IS NULL)`,
		),
	],
)

// One row per provider contact record. A contact has no address: cards go to the company office.
export const contacts = pgTable(
	'contacts',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		provider: text().notNull(),
		externalId: text().notNull(),
		rawRecordId: integer()
			.notNull()
			.references(() => rawRecords.id),
		sourceCompanyId: integer().references(() => sourceCompanies.id),
		personKey: text().notNull(),
		// sha256 of person_key, matched against suppressions.person_key_hash.
		personKeyHash: text().notNull(),
		firstName: text(),
		lastName: text(),
		fullName: text(),
		title: text(),
		seniority: text().notNull(),
		functions: text().array().notNull(),
		emailStatus: text(),
		fetchedAt: timestamp({ withTimezone: true }).notNull(),
	},
	(t) => [
		unique('contacts_record').on(t.provider, t.externalId),
		index('contacts_person_key').on(t.personKey),
		index('contacts_person_key_hash').on(t.personKeyHash),
		index('contacts_source_company').on(t.sourceCompanyId),
	],
)

// Keyed on the chosen source record, so the override survives re-pulls and follows the record through merges.
export const fieldOverrides = pgTable(
	'field_overrides',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		companyId: integer()
			.notNull()
			.references(() => companies.id),
		field: text().$type<FieldName>().notNull(),
		chosenSourceId: integer()
			.notNull()
			.references(() => sourceCompanies.id),
		createdBy: text()
			.notNull()
			.references(() => users.id),
		reason: text().notNull(),
		at: timestamp({ withTimezone: true }).notNull(),
	},
	(t) => [check('field_overrides_reason', sql`btrim(${t.reason}) <> ''`)],
)

// Human decisions about pairs of source records. The latest decision for a pair wins.
export const matchDecisions = pgTable(
	'match_decisions',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		sourceA: integer()
			.notNull()
			.references(() => sourceCompanies.id),
		sourceB: integer()
			.notNull()
			.references(() => sourceCompanies.id),
		decision: text().notNull(),
		reason: text().notNull(),
		createdBy: text()
			.notNull()
			.references(() => users.id),
		at: timestamp({ withTimezone: true }).notNull(),
	},
	(t) => [
		check('match_decisions_order', sql`${t.sourceA} < ${t.sourceB}`),
		check('match_decisions_decision', sql`${t.decision} IN ('merge', 'split')`),
		check('match_decisions_reason', sql`btrim(${t.reason}) <> ''`),
	],
)

// Lazily generated and cached per company, ICP version and evidence: the same facts never cost a second call.
export const scoreRationales = pgTable(
	'score_rationales',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		companyId: integer()
			.notNull()
			.references(() => companies.id),
		icpVersionId: integer()
			.notNull()
			.references(() => icpVersions.id),
		evidenceHash: text().notNull(),
		evidence: jsonb().$type<EvidenceItem[]>().notNull(),
		status: text().$type<'accepted' | 'rejected'>().notNull(),
		text: text().notNull(),
		cites: jsonb().$type<string[]>().notNull(),
		rejections: jsonb().$type<Rejection[]>().notNull(),
		raw: text(),
		model: text().notNull(),
		promptVersion: text().notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull(),
	},
	(t) => [
		unique('score_rationales_key').on(t.companyId, t.icpVersionId, t.evidenceHash),
		check('score_rationales_status', sql`${t.status} IN ('accepted', 'rejected')`),
	],
)

export const campaigns = pgTable(
	'campaigns',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		// Client-supplied: a retried create returns the same campaign instead of a second one.
		idempotencyKey: text().notNull().unique(),
		requestHash: text().notNull(),
		name: text().notNull(),
		icpVersionId: integer()
			.notNull()
			.references(() => icpVersions.id),
		topN: integer().notNull(),
		templateAId: integer()
			.notNull()
			.references(() => templates.id),
		templateBId: integer()
			.notNull()
			.references(() => templates.id),
		status: text().$type<'draft' | 'sending' | 'sent'>().notNull().default('draft'),
		createdBy: text()
			.notNull()
			.references(() => users.id),
		createdAt: timestamp({ withTimezone: true }).notNull(),
		launchedBy: text(),
		launchedByRole: userRole(),
		launchedAt: timestamp({ withTimezone: true }),
	},
	(t) => [
		check('campaigns_status', sql`${t.status} IN ('draft', 'sending', 'sent')`),
		// Only a lead launches a send, and the database checks it.
		foreignKey({
			name: 'campaigns_launched_by_user_role',
			columns: [t.launchedBy, t.launchedByRole],
			foreignColumns: [users.id, users.role],
		}),
		check('campaigns_launcher_is_lead', sql`${t.launchedByRole} IS NULL OR ${t.launchedByRole} = 'lead'`),
		// Without this, a NULL role would skip the FK (MATCH SIMPLE) and any id could launch.
		check('campaigns_launcher_has_role', sql`(${t.launchedBy} IS NULL) = (${t.launchedByRole} IS NULL)`),
		check(
			'campaigns_launch_recorded',
			sql`(${t.status} = 'draft') = (${t.launchedAt} IS NULL) AND (${t.launchedAt} IS NULL) = (${t.launchedBy} IS NULL)`,
		),
	],
)

export const CARD_STATUSES = [
	'draft',
	'approved',
	'rejected',
	'blocked',
	'queued',
	'submitted',
	'printed',
	'mailed',
	'delivered',
	'returned',
	'blocked_at_send',
	'failed',
	// The mail API never answered: it may or may not have the postcard. Retried with the same key.
	'unconfirmed',
] as const
export type CardStatus = (typeof CARD_STATUSES)[number]

export interface CardRecipient {
	fullName: string | null
	firstName: string | null
	title: string | null
	function: string | null
	seniority: string
	providers: string[]
	decidedBy: DecidedBy | 'seeded history'
	candidates: Candidate[]
}

export const cards = pgTable(
	'cards',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		campaignId: integer()
			.notNull()
			.references(() => campaigns.id),
		companyId: integer()
			.notNull()
			.references(() => companies.id),
		contactId: integer()
			.notNull()
			.references(() => contacts.id),
		// The person as of building the card: the 90-day rule and history match on it, whatever happens to the records.
		personKey: text().notNull(),
		rank: integer().notNull(),
		score: numeric().notNull(),
		scoreDisplay: integer().notNull(),
		contributions: jsonb().$type<unknown[]>().notNull(),
		recipient: jsonb().$type<CardRecipient>().notNull(),
		address: jsonb().$type<Record<string, string | null> | null>(),
		eligibility: text().$type<'eligible' | 'blocked'>().notNull(),
		blockReason: text(),
		variant: text().$type<'A' | 'B'>(),
		personalLine: text().notNull(),
		lineSource: text().$type<'llm' | 'template' | 'human'>().notNull(),
		lineCites: jsonb().$type<string[]>().notNull(),
		lineEvidence: jsonb().$type<EvidenceItem[]>().notNull(),
		llmStatus: text().$type<'accepted' | 'rejected'>(),
		llmRejections: jsonb().$type<Rejection[]>().notNull().default([]),
		llmRaw: text(),
		llmModel: text(),
		promptVersion: text(),
		status: text().$type<CardStatus>().notNull(),
		rejectReason: text(),
		approvedBy: text(),
		approvedByRole: userRole(),
		approvedAt: timestamp({ withTimezone: true }),
		// Generated at approval, before any send attempt, and sent as the mail API's Idempotency-Key.
		idempotencyKey: text().unique(),
		mailId: text().unique(),
		sendError: text(),
		submittedAt: timestamp({ withTimezone: true }),
		mailedAt: timestamp({ withTimezone: true }),
		statusChangedAt: timestamp({ withTimezone: true }).notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull(),
	},
	(t) => [
		unique('cards_campaign_company').on(t.campaignId, t.companyId),
		index('cards_person_key').on(t.personKey, t.submittedAt),
		check('cards_status', sql.raw(`status IN (${CARD_STATUSES.map((status) => `'${status}'`).join(', ')})`)),
		check('cards_eligibility', sql`${t.eligibility} IN ('eligible', 'blocked')`),
		check('cards_blocked_at_build', sql`(${t.eligibility} = 'blocked') = (${t.status} = 'blocked')`),
		check('cards_block_reason', sql`(${t.status} IN ('blocked', 'blocked_at_send')) = (${t.blockReason} IS NOT NULL)`),
		check('cards_reject_reason', sql`(${t.status} = 'rejected') = (btrim(coalesce(${t.rejectReason}, '')) <> '')`),
		check('cards_variant', sql`(${t.eligibility} = 'eligible') = (${t.variant} IN ('A', 'B'))`),
		// Approved or later needs a recorded approval by a lead; the FK below ties approver and role to a real user.
		check(
			'cards_approval_recorded',
			sql`${t.status} IN ('draft', 'rejected', 'blocked') OR (${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL AND ${t.idempotencyKey} IS NOT NULL)`,
		),
		check('cards_approver_is_lead', sql`${t.approvedByRole} IS NULL OR ${t.approvedByRole} = 'lead'`),
		// Without this, a NULL role would skip the FK (MATCH SIMPLE) and a rep, or any string, could approve.
		check('cards_approver_has_role', sql`(${t.approvedBy} IS NULL) = (${t.approvedByRole} IS NULL)`),
		foreignKey({
			name: 'cards_approved_by_user_role',
			columns: [t.approvedBy, t.approvedByRole],
			foreignColumns: [users.id, users.role],
		}),
	],
)

export const submissionAttempts = pgTable(
	'submission_attempts',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		cardId: integer()
			.notNull()
			.references(() => cards.id),
		n: integer().notNull(),
		outcome: text().$type<'ok' | 'timeout' | 'error'>().notNull(),
		httpStatus: integer(),
		// How long the worker waited before the next attempt (full jitter); null when there was none.
		delayMs: integer(),
		error: text(),
		at: timestamp({ withTimezone: true }).notNull(),
	},
	(t) => [
		unique('submission_attempts_card_n').on(t.cardId, t.n),
		check('submission_attempts_outcome', sql`${t.outcome} IN ('ok', 'timeout', 'error')`),
	],
)

// Every webhook as received. A forged one is kept for the record without its event id, so it cannot block the real event.
export const mailEvents = pgTable(
	'mail_events',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		providerEventId: text().unique(),
		mailId: text(),
		status: text(),
		occurredAt: timestamp({ withTimezone: true }),
		receivedAt: timestamp({ withTimezone: true }).notNull(),
		payload: jsonb().notNull(),
		signatureOk: boolean().notNull(),
	},
	(t) => [
		index('mail_events_mail_id').on(t.mailId),
		check('mail_events_verified_id', sql`${t.signatureOk} OR ${t.providerEventId} IS NULL`),
	],
)

// Replies, website visits and meetings. Attributed to cards at read time, so the 30-day rule is never baked in.
export const outcomeEvents = pgTable(
	'outcome_events',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		kind: text().$type<'reply' | 'visit' | 'meeting'>().notNull(),
		domain: text(),
		personKey: text(),
		occurredAt: timestamp({ withTimezone: true }).notNull(),
		source: text().notNull(),
		note: text(),
		idempotencyKey: text().notNull().unique(),
		createdBy: text().notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull(),
	},
	(t) => [
		check('outcome_events_kind', sql`${t.kind} IN ('reply', 'visit', 'meeting')`),
		check('outcome_events_target', sql`${t.domain} IS NOT NULL OR ${t.personKey} IS NOT NULL`),
		index('outcome_events_occurred').on(t.occurredAt),
	],
)
