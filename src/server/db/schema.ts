import type { FieldName } from '#common/settings.ts'
import { sql, type SQL } from 'drizzle-orm'
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
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	type AnyPgColumn,
	type PgColumn,
} from 'drizzle-orm/pg-core'
import type { EvidenceItem, Rejection } from '../llm/types.ts'
import type { ResolvedFields } from '../pipeline/resolve/core.ts'
import type { Contribution } from '../pipeline/score/core.ts'
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
			sql`(${t.decision} IS DISTINCT FROM 'rejected' AND ${t.action} NOT IN ('company.merged', 'company.unmerged', 'company.merge_undone', 'field.overridden')) OR btrim(coalesce(${t.reason}, '')) <> ''`,
		),
		index('audit_events_entity').on(t.entityType, t.entityId, t.at),
		index('audit_events_at').on(t.at),
		// The audit log filters by who and by action, newest first.
		index('audit_events_actor').on(t.actorId, t.at),
		index('audit_events_action').on(t.action, t.at),
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

export const templates = pgTable('templates', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	name: text().notNull().unique(),
	body: text().notNull(),
})

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
		// 'queued' until the job runner picks the pull up; started_at then moves to when it really began.
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
		check(
			'ingestion_runs_status',
			sql`${t.status} IN ('queued', 'running', 'succeeded', 'succeeded_with_errors', 'failed')`,
		),
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

// Every record a run received, new or unchanged, so each run stays browsable after later runs move last_seen_*.
export const ingestionRunRecords = pgTable(
	'ingestion_run_records',
	{
		runId: integer()
			.notNull()
			.references(() => ingestionRuns.id),
		rawRecordId: integer()
			.notNull()
			.references(() => rawRecords.id),
	},
	(t) => [primaryKey({ columns: [t.runId, t.rawRecordId] })],
)

export const companies = pgTable(
	'companies',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		// Set when a merge took every record of this company: where they went. Links to it lead there instead of nowhere.
		mergedInto: integer().references((): AnyPgColumn => companies.id),
	},
	(t) => [
		check('companies_not_merged_into_itself', sql`${t.mergedInto} <> ${t.id}`),
		index('companies_merged_into').on(t.mergedInto),
	],
)

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
		// A new reply or visit finds the campaigns that mailed its company by domain (results_changed trigger).
		index('source_companies_domain').on(t.normalisedDomain),
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
	(t) => [
		check('field_overrides_reason', sql`btrim(${t.reason}) <> ''`),
		// Refreshing a company's profile reads the overrides of its source records.
		index('field_overrides_chosen_source').on(t.chosenSourceId),
	],
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
		// Null when the campaign runs without an A/B test: every eligible card then uses template A.
		templateBId: integer().references(() => templates.id),
		// No stored status: where a campaign stands is read from its cards, so it can never disagree with them.
		createdBy: text()
			.notNull()
			.references(() => users.id),
		createdAt: timestamp({ withTimezone: true }).notNull(),
		launchedBy: text(),
		launchedByRole: userRole(),
		launchedAt: timestamp({ withTimezone: true }),
	},
	(t) => [
		// Only a lead launches a send, and the database checks it.
		foreignKey({
			name: 'campaigns_launched_by_user_role',
			columns: [t.launchedBy, t.launchedByRole],
			foreignColumns: [users.id, users.role],
		}),
		check('campaigns_launcher_is_lead', sql`${t.launchedByRole} IS NULL OR ${t.launchedByRole} = 'lead'`),
		// Without this, a NULL role would skip the FK (MATCH SIMPLE) and any id could launch.
		check('campaigns_launcher_has_role', sql`(${t.launchedBy} IS NULL) = (${t.launchedByRole} IS NULL)`),
		check('campaigns_launch_recorded', sql`(${t.launchedAt} IS NULL) = (${t.launchedBy} IS NULL)`),
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

export interface CardAddressSource {
	provider: string | null
	rawRecordId: number | null
	// Providers disagreed on the address when the card was built; chosenBy is set if a person picked the value.
	conflict: boolean
	chosenBy: string | null
}

export const cards = pgTable(
	'cards',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		campaignId: integer()
			.notNull()
			.references(() => campaigns.id),
		// The company as of building the card. Merges and splits move records, not cards: see sourceCompanyId.
		companyId: integer()
			.notNull()
			.references(() => companies.id),
		// The recipient's provider record. The card belongs to whichever company holds it now (cardCompany in
		// resolve/store.ts), so it follows its person through merges and splits. Null with no recipient.
		sourceCompanyId: integer().references(() => sourceCompanies.id),
		// Null only on a card blocked for 'no_contact': the company is shown as skipped, never silently dropped.
		contactId: integer().references(() => contacts.id),
		// The person as of building the card: the 90-day rule and history match on it, whatever happens to the records.
		personKey: text(),
		rank: integer().notNull(),
		score: numeric().notNull(),
		scoreDisplay: integer().notNull(),
		contributions: jsonb().$type<unknown[]>().notNull(),
		recipient: jsonb().$type<CardRecipient>(),
		address: jsonb().$type<Record<string, string | null> | null>(),
		addressSource: jsonb().$type<CardAddressSource>(),
		eligibility: text().$type<'eligible' | 'blocked'>().notNull(),
		blockReason: text(),
		variant: text().$type<'A' | 'B'>(),
		// Null while the campaign's "write lines" job has not reached this card; such a card cannot be approved.
		personalLine: text(),
		lineSource: text().$type<'llm' | 'template' | 'human'>(),
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
		// When the mail reconciler last asked the provider about this card, whatever it answered.
		reconciledAt: timestamp({ withTimezone: true }),
		statusChangedAt: timestamp({ withTimezone: true }).notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull(),
	},
	(t) => [
		unique('cards_campaign_company').on(t.campaignId, t.companyId),
		// Results find every mailing to a company, whatever campaign it was in.
		index('cards_company').on(t.companyId, t.mailedAt),
		index('cards_source_company').on(t.sourceCompanyId, t.mailedAt),
		index('cards_person_key').on(t.personKey, t.submittedAt),
		// Keyset page of what has been mailed, newest first.
		index('cards_submitted')
			.on(t.submittedAt.desc(), t.id.desc())
			.where(sql`${t.submittedAt} IS NOT NULL`),
		// The reconciler's pick: cards at the provider that have not reached a final status.
		index('cards_in_flight')
			.on(t.statusChangedAt, t.id)
			.where(sql`${t.status} IN ('submitted', 'printed', 'mailed')`),
		check('cards_status', sql.raw(`status IN (${CARD_STATUSES.map((status) => `'${status}'`).join(', ')})`)),
		check('cards_eligibility', sql`${t.eligibility} IN ('eligible', 'blocked')`),
		check('cards_blocked_at_build', sql`(${t.eligibility} = 'blocked') = (${t.status} = 'blocked')`),
		check('cards_block_reason', sql`(${t.status} IN ('blocked', 'blocked_at_send')) = (${t.blockReason} IS NOT NULL)`),
		check(
			'cards_recipient_present',
			sql`(${t.contactId} IS NULL) = (${t.blockReason} IS NOT DISTINCT FROM 'no_contact') AND (${t.personKey} IS NULL) = (${t.contactId} IS NULL) AND (${t.recipient} IS NULL) = (${t.contactId} IS NULL)`,
		),
		check('cards_reject_reason', sql`(${t.status} = 'rejected') = (btrim(coalesce(${t.rejectReason}, '')) <> '')`),
		check('cards_variant', sql`(${t.eligibility} = 'eligible') = (${t.variant} IN ('A', 'B'))`),
		// Approved or later needs a recorded approval by a lead; the FK below ties approver and role to a real user.
		check(
			'cards_approval_recorded',
			sql`${t.status} IN ('draft', 'rejected', 'blocked') OR (${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL AND ${t.idempotencyKey} IS NOT NULL)`,
		),
		check('cards_line_source', sql`(${t.personalLine} IS NULL) = (${t.lineSource} IS NULL)`),
		// Nothing without a line can be approved, so a postcard never prints empty.
		check('cards_line_present', sql`${t.status} IN ('draft', 'rejected', 'blocked') OR ${t.personalLine} IS NOT NULL`),
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

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

// Background work for the one app server (see jobs.ts). `key` names what the job is about, so a double click or a
// retried request finds the job that is already active instead of starting a second one.
export const jobs = pgTable(
	'jobs',
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		kind: text().notNull(),
		key: text().notNull(),
		payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		status: text().$type<JobStatus>().notNull().default('queued'),
		attempts: integer().notNull().default(0),
		error: text(),
		createdBy: text().notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull(),
		startedAt: timestamp({ withTimezone: true }),
		finishedAt: timestamp({ withTimezone: true }),
	},
	(t) => [
		// At most one active job per key; finished jobs stay as history.
		uniqueIndex('jobs_active_key')
			.on(t.kind, t.key)
			.where(sql`${t.status} IN ('queued', 'running')`),
		index('jobs_queued')
			.on(t.id)
			.where(sql`${t.status} = 'queued'`),
		check('jobs_status', sql.raw(`status IN (${JOB_STATUSES.map((status) => `'${status}'`).join(', ')})`)),
		check('jobs_finished', sql`(${t.finishedAt} IS NOT NULL) = (${t.status} IN ('done', 'failed'))`),
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
		// signature_ok means trusted: a webhook with a valid signature, or an event we fetched from the provider ourselves.
		signatureOk: boolean().notNull(),
		source: text().$type<'webhook' | 'reconcile'>().notNull().default('webhook'),
	},
	(t) => [
		check('mail_events_source', sql`${t.source} IN ('webhook', 'reconcile')`),
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
		// Attribution looks events up by the company domain or the person a card went to.
		index('outcome_events_domain').on(t.domain, t.occurredAt),
		index('outcome_events_person').on(t.personKey, t.occurredAt),
	],
)

// Keyset sorts for the companies list: unknown values last in both directions, ties by company id ascending, so each
// direction needs its own index. Text sorts compare like the screens did (case- and accent-blind, numbers as numbers).
const sortIndexes = (name: string, key: SQL, id: PgColumn) => [
	index(`company_profiles_${name}_asc`).using('btree', sql`${key} ASC NULLS LAST`, id),
	index(`company_profiles_${name}_desc`).using('btree', sql`${key} DESC NULLS LAST`, id),
]

// The resolved company master, one row per company that has source records, kept current by refreshProfiles in
// the transaction of every write it is built from. `fields` holds every value with its provenance and stale = false:
// staleness depends on the day, so readers put it back from `as of` dates (field_as_of in SQL).
export const companyProfiles = pgTable(
	'company_profiles',
	{
		companyId: integer()
			.primaryKey()
			.references(() => companies.id),
		fields: jsonb().$type<ResolvedFields>().notNull(),
		name: text(),
		domain: text(),
		country: text(),
		industry: text(),
		industryLabel: text(),
		headcount: integer(),
		revenueGbp: numeric(),
		signals: text().array().notNull(),
		providers: text().array().notNull(),
		sourceCount: integer().notNull(),
		contactCount: integer().notNull(),
		conflicts: text().$type<FieldName>().array().notNull(),
		overridden: text().$type<FieldName>().array().notNull(),
		// The winning value's provider "as of" date per field, in FIELDS order (text, compared as the code compares).
		fieldAsOf: text().array().$type<(string | null)[]>().notNull(),
		// Lower-cased name, domain and every source record's name, for the list search.
		search: text().notNull(),
	},
	(t) => [
		...sortIndexes('name', sql`${t.name} COLLATE natural_sort`, t.companyId),
		...sortIndexes('country', sql`${t.country} COLLATE natural_sort`, t.companyId),
		...sortIndexes('industry', sql`${t.industry} COLLATE natural_sort`, t.companyId),
		...sortIndexes('headcount', sql`${t.headcount}`, t.companyId),
		...sortIndexes('revenue', sql`${t.revenueGbp}`, t.companyId),
		...sortIndexes('sources', sql`cardinality(${t.providers})`, t.companyId),
		// Results attribute visits by the company's domain.
		index('company_profiles_domain').on(t.domain),
	],
)

// Pairs of companies that look alike but were kept apart, recomputed by every re-clustering.
export const companyDuplicates = pgTable(
	'company_duplicates',
	{
		companyA: integer()
			.notNull()
			.references(() => companies.id),
		companyB: integer()
			.notNull()
			.references(() => companies.id),
		sourceA: integer()
			.notNull()
			.references(() => sourceCompanies.id),
		sourceB: integer()
			.notNull()
			.references(() => sourceCompanies.id),
		reason: text().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.companyA, t.companyB] }),
		index('company_duplicates_b').on(t.companyB),
		check('company_duplicates_order', sql`${t.companyA} < ${t.companyB}`),
	],
)

// ICP versions whose scores are stored for every profile. Scored when saved, or on first read for older versions.
export const scoredIcpVersions = pgTable('scored_icp_versions', {
	icpVersionId: integer()
		.primaryKey()
		.references(() => icpVersions.id),
})

// One score per scored ICP version and profile; refreshProfiles rescores the companies it refreshes.
export const companyScores = pgTable(
	'company_scores',
	{
		icpVersionId: integer()
			.notNull()
			.references(() => scoredIcpVersions.icpVersionId),
		companyId: integer()
			.notNull()
			.references(() => companyProfiles.companyId, { onDelete: 'cascade' }),
		inProfile: boolean().notNull(),
		score: numeric().notNull(),
		display: integer().notNull(),
		contributions: jsonb().$type<Contribution[]>().notNull(),
		outReasons: text().array().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.icpVersionId, t.companyId] }),
		// Rank order: highest exact score first, ties by company id. Out of the profile: by company id.
		index('company_scores_ranked')
			.on(t.icpVersionId, t.score.desc(), t.companyId)
			.where(sql`${t.inProfile}`),
		index('company_scores_out')
			.on(t.icpVersionId, t.companyId)
			.where(sql`NOT ${t.inProfile}`),
		index('company_scores_company').on(t.companyId),
	],
)
