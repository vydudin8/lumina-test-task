-- The companies list sorts text like the screens always did (Intl.Collator, sensitivity 'base', numeric): case and
-- accents ignored, digits compared as numbers. Nondeterministic, so 'ACME' and 'Acme' tie and the company id decides.
CREATE COLLATION natural_sort (provider = icu, locale = 'en-u-ks-level1-kn-true', deterministic = false);
--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('rep', 'lead');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"decision" text,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"result" jsonb,
	"request_id" text,
	CONSTRAINT "audit_actor" CHECK ("audit_events"."actor_role" IN ('rep', 'lead', 'system') AND ("audit_events"."actor_role" = 'system') = ("audit_events"."actor_id" LIKE 'system:%')),
	CONSTRAINT "audit_decision" CHECK ("audit_events"."decision" IN ('approved', 'rejected', 'overridden', 'blocked')),
	CONSTRAINT "audit_reason_required" CHECK (("audit_events"."decision" IS DISTINCT FROM 'rejected' AND "audit_events"."action" NOT IN ('company.merged', 'company.unmerged', 'company.merge_undone', 'field.overridden')) OR btrim(coalesce("audit_events"."reason", '')) <> '')
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "campaigns_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"name" text NOT NULL,
	"icp_version_id" integer NOT NULL,
	"top_n" integer NOT NULL,
	"template_a_id" integer NOT NULL,
	"template_b_id" integer,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"launched_by" text,
	"launched_by_role" "user_role",
	"launched_at" timestamp with time zone,
	CONSTRAINT "campaigns_idempotencyKey_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "campaigns_launcher_is_lead" CHECK ("campaigns"."launched_by_role" IS NULL OR "campaigns"."launched_by_role" = 'lead'),
	CONSTRAINT "campaigns_launcher_has_role" CHECK (("campaigns"."launched_by" IS NULL) = ("campaigns"."launched_by_role" IS NULL)),
	CONSTRAINT "campaigns_launch_recorded" CHECK (("campaigns"."launched_at" IS NULL) = ("campaigns"."launched_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cards_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"campaign_id" integer NOT NULL,
	"company_id" integer NOT NULL,
	"source_company_id" integer,
	"contact_id" integer,
	"person_key" text,
	"rank" integer NOT NULL,
	"score" numeric NOT NULL,
	"score_display" integer NOT NULL,
	"contributions" jsonb NOT NULL,
	"recipient" jsonb,
	"address" jsonb,
	"address_source" jsonb,
	"eligibility" text NOT NULL,
	"block_reason" text,
	"variant" text,
	"personal_line" text,
	"line_source" text,
	"line_cites" jsonb NOT NULL,
	"line_evidence" jsonb NOT NULL,
	"llm_status" text,
	"llm_rejections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"llm_raw" text,
	"llm_model" text,
	"prompt_version" text,
	"status" text NOT NULL,
	"reject_reason" text,
	"approved_by" text,
	"approved_by_role" "user_role",
	"approved_at" timestamp with time zone,
	"idempotency_key" text,
	"mail_id" text,
	"send_error" text,
	"submitted_at" timestamp with time zone,
	"mailed_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"status_changed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cards_idempotencyKey_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "cards_mailId_unique" UNIQUE("mail_id"),
	CONSTRAINT "cards_campaign_company" UNIQUE("campaign_id","company_id"),
	CONSTRAINT "cards_status" CHECK (status IN ('draft', 'approved', 'rejected', 'blocked', 'queued', 'submitted', 'printed', 'mailed', 'delivered', 'returned', 'blocked_at_send', 'failed', 'unconfirmed')),
	CONSTRAINT "cards_eligibility" CHECK ("cards"."eligibility" IN ('eligible', 'blocked')),
	CONSTRAINT "cards_blocked_at_build" CHECK (("cards"."eligibility" = 'blocked') = ("cards"."status" = 'blocked')),
	CONSTRAINT "cards_block_reason" CHECK (("cards"."status" IN ('blocked', 'blocked_at_send')) = ("cards"."block_reason" IS NOT NULL)),
	CONSTRAINT "cards_recipient_present" CHECK (("cards"."contact_id" IS NULL) = ("cards"."block_reason" IS NOT DISTINCT FROM 'no_contact') AND ("cards"."person_key" IS NULL) = ("cards"."contact_id" IS NULL) AND ("cards"."recipient" IS NULL) = ("cards"."contact_id" IS NULL)),
	CONSTRAINT "cards_reject_reason" CHECK (("cards"."status" = 'rejected') = (btrim(coalesce("cards"."reject_reason", '')) <> '')),
	CONSTRAINT "cards_variant" CHECK (("cards"."eligibility" = 'eligible') = ("cards"."variant" IN ('A', 'B'))),
	CONSTRAINT "cards_approval_recorded" CHECK ("cards"."status" IN ('draft', 'rejected', 'blocked') OR ("cards"."approved_by" IS NOT NULL AND "cards"."approved_at" IS NOT NULL AND "cards"."idempotency_key" IS NOT NULL)),
	CONSTRAINT "cards_line_source" CHECK (("cards"."personal_line" IS NULL) = ("cards"."line_source" IS NULL)),
	CONSTRAINT "cards_line_present" CHECK ("cards"."status" IN ('draft', 'rejected', 'blocked') OR "cards"."personal_line" IS NOT NULL),
	CONSTRAINT "cards_approver_is_lead" CHECK ("cards"."approved_by_role" IS NULL OR "cards"."approved_by_role" = 'lead'),
	CONSTRAINT "cards_approver_has_role" CHECK (("cards"."approved_by" IS NULL) = ("cards"."approved_by_role" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "companies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"merged_into" integer,
	CONSTRAINT "companies_not_merged_into_itself" CHECK ("companies"."merged_into" <> "companies"."id")
);
--> statement-breakpoint
CREATE TABLE "company_duplicates" (
	"company_a" integer NOT NULL,
	"company_b" integer NOT NULL,
	"source_a" integer NOT NULL,
	"source_b" integer NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "company_duplicates_company_a_company_b_pk" PRIMARY KEY("company_a","company_b"),
	CONSTRAINT "company_duplicates_order" CHECK ("company_duplicates"."company_a" < "company_duplicates"."company_b")
);
--> statement-breakpoint
CREATE TABLE "company_profiles" (
	"company_id" integer PRIMARY KEY NOT NULL,
	"fields" jsonb NOT NULL,
	"name" text,
	"domain" text,
	"country" text,
	"industry" text,
	"industry_label" text,
	"headcount" integer,
	"revenue_gbp" numeric,
	"signals" text[] NOT NULL,
	"providers" text[] NOT NULL,
	"source_count" integer NOT NULL,
	"contact_count" integer NOT NULL,
	"conflicts" text[] NOT NULL,
	"overridden" text[] NOT NULL,
	"field_as_of" text[] NOT NULL,
	"search" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_scores" (
	"icp_version_id" integer NOT NULL,
	"company_id" integer NOT NULL,
	"in_profile" boolean NOT NULL,
	"score" numeric NOT NULL,
	"display" integer NOT NULL,
	"contributions" jsonb NOT NULL,
	"out_reasons" text[] NOT NULL,
	CONSTRAINT "company_scores_icp_version_id_company_id_pk" PRIMARY KEY("icp_version_id","company_id")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "contacts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"raw_record_id" integer NOT NULL,
	"source_company_id" integer,
	"person_key" text NOT NULL,
	"person_key_hash" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"full_name" text,
	"title" text,
	"seniority" text NOT NULL,
	"functions" text[] NOT NULL,
	"email_status" text,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "contacts_record" UNIQUE("provider","external_id")
);
--> statement-breakpoint
CREATE TABLE "field_overrides" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "field_overrides_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"company_id" integer NOT NULL,
	"field" text NOT NULL,
	"chosen_source_id" integer NOT NULL,
	"created_by" text NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "field_overrides_reason" CHECK (btrim("field_overrides"."reason") <> '')
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fx_rates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"currency" text NOT NULL,
	"rate" numeric NOT NULL,
	"as_of" date NOT NULL,
	CONSTRAINT "fx_rates_currency_as_of" UNIQUE("currency","as_of"),
	CONSTRAINT "fx_rates_positive" CHECK ("fx_rates"."rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "icp_versions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "icp_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"rules" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_run_records" (
	"run_id" integer NOT NULL,
	"raw_record_id" integer NOT NULL,
	CONSTRAINT "ingestion_run_records_run_id_raw_record_id_pk" PRIMARY KEY("run_id","raw_record_id")
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ingestion_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"provider" text NOT NULL,
	"triggered_by" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"records_received" integer DEFAULT 0 NOT NULL,
	"records_new" integer DEFAULT 0 NOT NULL,
	"records_unchanged" integer DEFAULT 0 NOT NULL,
	"records_rejected" integer DEFAULT 0 NOT NULL,
	"credits_used" numeric DEFAULT '0' NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "ingestion_runs_status" CHECK ("ingestion_runs"."status" IN ('queued', 'running', 'succeeded', 'succeeded_with_errors', 'failed')),
	CONSTRAINT "ingestion_runs_provider" CHECK ("ingestion_runs"."provider" IN ('apollo', 'factset', 'clay'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_status" CHECK (status IN ('queued', 'running', 'done', 'failed')),
	CONSTRAINT "jobs_finished" CHECK (("jobs"."finished_at" IS NOT NULL) = ("jobs"."status" IN ('done', 'failed')))
);
--> statement-breakpoint
CREATE TABLE "mail_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mail_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"provider_event_id" text,
	"mail_id" text,
	"status" text,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"signature_ok" boolean NOT NULL,
	"source" text DEFAULT 'webhook' NOT NULL,
	CONSTRAINT "mail_events_providerEventId_unique" UNIQUE("provider_event_id"),
	CONSTRAINT "mail_events_source" CHECK ("mail_events"."source" IN ('webhook', 'reconcile')),
	CONSTRAINT "mail_events_verified_id" CHECK ("mail_events"."signature_ok" OR "mail_events"."provider_event_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "match_decisions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "match_decisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"source_a" integer NOT NULL,
	"source_b" integer NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "match_decisions_order" CHECK ("match_decisions"."source_a" < "match_decisions"."source_b"),
	CONSTRAINT "match_decisions_decision" CHECK ("match_decisions"."decision" IN ('merge', 'split')),
	CONSTRAINT "match_decisions_reason" CHECK (btrim("match_decisions"."reason") <> '')
);
--> statement-breakpoint
CREATE TABLE "outcome_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outcome_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"domain" text,
	"person_key" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"note" text,
	"idempotency_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "outcome_events_idempotencyKey_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "outcome_events_kind" CHECK ("outcome_events"."kind" IN ('reply', 'visit', 'meeting')),
	CONSTRAINT "outcome_events_target" CHECK ("outcome_events"."domain" IS NOT NULL OR "outcome_events"."person_key" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "raw_records" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "raw_records_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"run_id" integer NOT NULL,
	"last_seen_run_id" integer NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "raw_records_version" UNIQUE("provider","kind","external_id","content_hash"),
	CONSTRAINT "raw_records_kind" CHECK ("raw_records"."kind" IN ('company', 'contact'))
);
--> statement-breakpoint
CREATE TABLE "score_rationales" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "score_rationales_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"company_id" integer NOT NULL,
	"icp_version_id" integer NOT NULL,
	"evidence_hash" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" text NOT NULL,
	"text" text NOT NULL,
	"cites" jsonb NOT NULL,
	"rejections" jsonb NOT NULL,
	"raw" text,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "score_rationales_key" UNIQUE("company_id","icp_version_id","evidence_hash"),
	CONSTRAINT "score_rationales_status" CHECK ("score_rationales"."status" IN ('accepted', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "scored_icp_versions" (
	"icp_version_id" integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seed_runs" (
	"version" integer PRIMARY KEY NOT NULL,
	"checksum" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_companies" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "source_companies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"raw_record_id" integer NOT NULL,
	"company_id" integer,
	"fetched_at" timestamp with time zone NOT NULL,
	"normalised_name" text,
	"normalised_domain" text,
	"country" text,
	"fields" jsonb NOT NULL,
	"revenue_amount" numeric,
	"revenue_currency" text,
	"revenue_gbp" numeric,
	"fx_rate_id" integer,
	CONSTRAINT "source_companies_record" UNIQUE("provider","external_id"),
	CONSTRAINT "source_companies_revenue" CHECK (("source_companies"."revenue_amount" IS NULL) = ("source_companies"."revenue_gbp" IS NULL) AND ("source_companies"."revenue_gbp" IS NULL) = ("source_companies"."fx_rate_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "submission_attempts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "submission_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"card_id" integer NOT NULL,
	"n" integer NOT NULL,
	"outcome" text NOT NULL,
	"http_status" integer,
	"delay_ms" integer,
	"error" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "submission_attempts_card_n" UNIQUE("card_id","n"),
	CONSTRAINT "submission_attempts_outcome" CHECK ("submission_attempts"."outcome" IN ('ok', 'timeout', 'error'))
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "suppressions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"person_key_hash" text NOT NULL,
	"reason" text NOT NULL,
	"source" text,
	"created_by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "suppressions_personKeyHash_unique" UNIQUE("person_key_hash"),
	CONSTRAINT "suppressions_hash" CHECK ("suppressions"."person_key_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "templates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "templates_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" NOT NULL,
	CONSTRAINT "users_id_role" UNIQUE("id","role")
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_icp_version_id_icp_versions_id_fk" FOREIGN KEY ("icp_version_id") REFERENCES "public"."icp_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_a_id_templates_id_fk" FOREIGN KEY ("template_a_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_b_id_templates_id_fk" FOREIGN KEY ("template_b_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_launched_by_user_role" FOREIGN KEY ("launched_by","launched_by_role") REFERENCES "public"."users"("id","role") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_source_company_id_source_companies_id_fk" FOREIGN KEY ("source_company_id") REFERENCES "public"."source_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_approved_by_user_role" FOREIGN KEY ("approved_by","approved_by_role") REFERENCES "public"."users"("id","role") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_merged_into_companies_id_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_duplicates" ADD CONSTRAINT "company_duplicates_company_a_companies_id_fk" FOREIGN KEY ("company_a") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_duplicates" ADD CONSTRAINT "company_duplicates_company_b_companies_id_fk" FOREIGN KEY ("company_b") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_duplicates" ADD CONSTRAINT "company_duplicates_source_a_source_companies_id_fk" FOREIGN KEY ("source_a") REFERENCES "public"."source_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_duplicates" ADD CONSTRAINT "company_duplicates_source_b_source_companies_id_fk" FOREIGN KEY ("source_b") REFERENCES "public"."source_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_profiles" ADD CONSTRAINT "company_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_scores" ADD CONSTRAINT "company_scores_icp_version_id_scored_icp_versions_icp_version_id_fk" FOREIGN KEY ("icp_version_id") REFERENCES "public"."scored_icp_versions"("icp_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_scores" ADD CONSTRAINT "company_scores_company_id_company_profiles_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_profiles"("company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_raw_record_id_raw_records_id_fk" FOREIGN KEY ("raw_record_id") REFERENCES "public"."raw_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_source_company_id_source_companies_id_fk" FOREIGN KEY ("source_company_id") REFERENCES "public"."source_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_overrides" ADD CONSTRAINT "field_overrides_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_overrides" ADD CONSTRAINT "field_overrides_chosen_source_id_source_companies_id_fk" FOREIGN KEY ("chosen_source_id") REFERENCES "public"."source_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_overrides" ADD CONSTRAINT "field_overrides_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icp_versions" ADD CONSTRAINT "icp_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_run_records" ADD CONSTRAINT "ingestion_run_records_run_id_ingestion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_run_records" ADD CONSTRAINT "ingestion_run_records_raw_record_id_raw_records_id_fk" FOREIGN KEY ("raw_record_id") REFERENCES "public"."raw_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_decisions" ADD CONSTRAINT "match_decisions_source_a_source_companies_id_fk" FOREIGN KEY ("source_a") REFERENCES "public"."source_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_decisions" ADD CONSTRAINT "match_decisions_source_b_source_companies_id_fk" FOREIGN KEY ("source_b") REFERENCES "public"."source_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_decisions" ADD CONSTRAINT "match_decisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_records" ADD CONSTRAINT "raw_records_run_id_ingestion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_records" ADD CONSTRAINT "raw_records_last_seen_run_id_ingestion_runs_id_fk" FOREIGN KEY ("last_seen_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_rationales" ADD CONSTRAINT "score_rationales_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_rationales" ADD CONSTRAINT "score_rationales_icp_version_id_icp_versions_id_fk" FOREIGN KEY ("icp_version_id") REFERENCES "public"."icp_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scored_icp_versions" ADD CONSTRAINT "scored_icp_versions_icp_version_id_icp_versions_id_fk" FOREIGN KEY ("icp_version_id") REFERENCES "public"."icp_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_companies" ADD CONSTRAINT "source_companies_raw_record_id_raw_records_id_fk" FOREIGN KEY ("raw_record_id") REFERENCES "public"."raw_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_companies" ADD CONSTRAINT "source_companies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_companies" ADD CONSTRAINT "source_companies_fx_rate_id_fx_rates_id_fk" FOREIGN KEY ("fx_rate_id") REFERENCES "public"."fx_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_attempts" ADD CONSTRAINT "submission_attempts_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_entity" ON "audit_events" USING btree ("entity_type","entity_id","at");--> statement-breakpoint
CREATE INDEX "audit_events_at" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_events_actor" ON "audit_events" USING btree ("actor_id","at");--> statement-breakpoint
CREATE INDEX "audit_events_action" ON "audit_events" USING btree ("action","at");--> statement-breakpoint
CREATE INDEX "cards_company" ON "cards" USING btree ("company_id","mailed_at");--> statement-breakpoint
CREATE INDEX "cards_source_company" ON "cards" USING btree ("source_company_id","mailed_at");--> statement-breakpoint
CREATE INDEX "cards_person_key" ON "cards" USING btree ("person_key","submitted_at");--> statement-breakpoint
CREATE INDEX "cards_submitted" ON "cards" USING btree ("submitted_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "cards"."submitted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "cards_in_flight" ON "cards" USING btree ("status_changed_at","id") WHERE "cards"."status" IN ('submitted', 'printed', 'mailed');--> statement-breakpoint
CREATE INDEX "companies_merged_into" ON "companies" USING btree ("merged_into");--> statement-breakpoint
CREATE INDEX "company_duplicates_b" ON "company_duplicates" USING btree ("company_b");--> statement-breakpoint
CREATE INDEX "company_profiles_name_asc" ON "company_profiles" USING btree ("name" COLLATE natural_sort ASC NULLS LAST,"company_id");--> statement-breakpoint
CREATE INDEX "company_profiles_name_desc" ON "company_profiles" USING btree ("name" COLLATE natural_sort DESC NULLS LAST,"company_id");--> statement-breakpoint
CREATE INDEX "company_profiles_country_asc" ON "company_profiles" USING btree ("country" COLLATE natural_sort ASC NULLS LAST,"company_id");--> statement-breakpoint
CREATE INDEX "company_profiles_country_desc" ON "company_profiles" USING btree ("country" COLLATE natural_sort DESC NULLS LAST,"company_id");--> statement-breakpoint
CREATE INDEX "company_profiles_industry_asc" ON "company_profiles" USING btree ("industry" COLLATE natural_sort ASC NULLS LAST,"company_id");--> statement-breakpoint
CREATE INDEX "company_profiles_industry_desc" ON "company_profiles" USING btree ("industry" COLLATE natural_sort DESC NULLS LAST,"company_id");--> statement-breakpoint
CREATE INDEX "company_profiles_headcount_asc" ON "company_profiles" USING btree ("headcount" ASC NULLS LAST,"company_id");--> statement-breakpoint
CREATE INDEX "company_profiles_headcount_desc" ON "company_profiles" USING btree ("headcount" DESC NULLS LAST,"company_id");--> statement-breakpoint
CREATE INDEX "company_profiles_revenue_asc" ON "company_profiles" USING btree ("revenue_gbp" ASC NULLS LAST,"company_id");--> statement-breakpoint
CREATE INDEX "company_profiles_revenue_desc" ON "company_profiles" USING btree ("revenue_gbp" DESC NULLS LAST,"company_id");--> statement-breakpoint
CREATE INDEX "company_profiles_sources_asc" ON "company_profiles" USING btree (cardinality("providers") ASC NULLS LAST,"company_id");--> statement-breakpoint
CREATE INDEX "company_profiles_sources_desc" ON "company_profiles" USING btree (cardinality("providers") DESC NULLS LAST,"company_id");--> statement-breakpoint
CREATE INDEX "company_profiles_domain" ON "company_profiles" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "company_scores_ranked" ON "company_scores" USING btree ("icp_version_id","score" DESC NULLS LAST,"company_id") WHERE "company_scores"."in_profile";--> statement-breakpoint
CREATE INDEX "company_scores_out" ON "company_scores" USING btree ("icp_version_id","company_id") WHERE NOT "company_scores"."in_profile";--> statement-breakpoint
CREATE INDEX "company_scores_company" ON "company_scores" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "contacts_person_key" ON "contacts" USING btree ("person_key");--> statement-breakpoint
CREATE INDEX "contacts_person_key_hash" ON "contacts" USING btree ("person_key_hash");--> statement-breakpoint
CREATE INDEX "contacts_source_company" ON "contacts" USING btree ("source_company_id");--> statement-breakpoint
CREATE INDEX "field_overrides_chosen_source" ON "field_overrides" USING btree ("chosen_source_id");--> statement-breakpoint
CREATE INDEX "ingestion_runs_provider_started" ON "ingestion_runs" USING btree ("provider","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_active_key" ON "jobs" USING btree ("kind","key") WHERE "jobs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "jobs_queued" ON "jobs" USING btree ("id") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "mail_events_mail_id" ON "mail_events" USING btree ("mail_id");--> statement-breakpoint
CREATE INDEX "outcome_events_domain" ON "outcome_events" USING btree ("domain","occurred_at");--> statement-breakpoint
CREATE INDEX "outcome_events_person" ON "outcome_events" USING btree ("person_key","occurred_at");--> statement-breakpoint
CREATE INDEX "raw_records_latest" ON "raw_records" USING btree ("provider","kind","external_id","fetched_at");--> statement-breakpoint
CREATE INDEX "source_companies_company" ON "source_companies" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "source_companies_domain" ON "source_companies" USING btree ("normalised_domain");--> statement-breakpoint
-- Hand-written SQL below: drizzle-kit does not generate functions, triggers or collations.
-- audit_events is append-only: corrections are new events, never edits.
CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update_delete BEFORE UPDATE OR DELETE ON audit_events
	FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
	FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
--> statement-breakpoint
-- ICP versions are immutable: an edit is a new version, so old scores and campaigns stay explainable.
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is immutable: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER icp_versions_immutable BEFORE UPDATE OR DELETE ON icp_versions
	FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
-- Live updates: every change to a campaign's cards, or to the campaign, tells listeners on 'lumina_changes' which
-- campaign changed. Postgres delivers at commit and folds identical payloads within one transaction into one, so a
-- bulk approval of 500 cards sends a single notice.
CREATE FUNCTION notify_campaign_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- IF, not CASE: plpgsql would read both fields, and each table has only one of them.
	IF TG_TABLE_NAME = 'campaigns' THEN
		PERFORM pg_notify('lumina_changes', 'campaign:' || NEW.id);
	ELSE
		PERFORM pg_notify('lumina_changes', 'campaign:' || NEW.campaign_id);
	END IF;
	RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER cards_notify AFTER INSERT OR UPDATE ON "cards" FOR EACH ROW EXECUTE FUNCTION notify_campaign_changed();
--> statement-breakpoint
CREATE TRIGGER campaigns_notify AFTER INSERT OR UPDATE ON "campaigns" FOR EACH ROW EXECUTE FUNCTION notify_campaign_changed();
--> statement-breakpoint
-- A reply, visit or meeting changes the results only of campaigns that mailed its person or a company with its
-- domain: notify those, by id. A card belongs to the company that holds its recipient's record now (cardCompany in
-- resolve/store.ts); a card without one, to its own company or the company that one was merged into.
CREATE FUNCTION notify_results_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM pg_notify('lumina_changes', 'results:' || affected.campaign_id)
	FROM (
		SELECT c.campaign_id
		FROM new_rows e
		JOIN cards c ON c.person_key = e.person_key
		WHERE c.mailed_at IS NOT NULL
		UNION
		SELECT c.campaign_id
		FROM new_rows e
		JOIN source_companies s ON s.normalised_domain = e.domain
		JOIN source_companies r ON r.company_id = s.company_id
		JOIN cards c ON c.source_company_id = r.id
		WHERE c.mailed_at IS NOT NULL
		UNION
		SELECT c.campaign_id
		FROM new_rows e
		JOIN source_companies s ON s.normalised_domain = e.domain
		JOIN companies co ON co.id = s.company_id OR co.merged_into = s.company_id
		JOIN cards c ON c.company_id = co.id
		WHERE c.mailed_at IS NOT NULL AND c.source_company_id IS NULL
	) affected;
	RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "outcome_events_notify" AFTER INSERT ON "outcome_events" REFERENCING NEW TABLE AS new_rows
	FOR EACH STATEMENT EXECUTE FUNCTION notify_results_changed();
--> statement-breakpoint
-- Live updates for background work: a pull's run row changes as the job runner moves it along, and a campaign page
-- must hear when its "write lines" job ends, because a failed job changes nothing on the cards themselves.
CREATE FUNCTION notify_run_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM pg_notify('lumina_changes', 'run:' || NEW.id);
	RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER ingestion_runs_notify AFTER INSERT OR UPDATE ON "ingestion_runs"
	FOR EACH ROW EXECUTE FUNCTION notify_run_changed();
--> statement-breakpoint
CREATE FUNCTION notify_lines_job_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.kind = 'campaign.lines' THEN
		PERFORM pg_notify('lumina_changes', 'campaign:' || NEW.key);
	END IF;
	RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER jobs_notify AFTER INSERT OR UPDATE ON "jobs"
	FOR EACH ROW EXECUTE FUNCTION notify_lines_job_changed();
--> statement-breakpoint
-- A pull's run row ends with its job. The pull handler marks the run failed itself, but a job can fail before or
-- outside it (interrupted by restarts too many times, a database error while starting or finishing), and a run left
-- 'queued' or 'running' keeps the Providers page's "Pull now" disabled for good.
CREATE FUNCTION fail_run_with_its_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	UPDATE ingestion_runs
	SET status = 'failed',
		finished_at = NEW.finished_at,
		errors = jsonb_build_array(jsonb_build_object(
			'kind', 'request',
			'externalId', NULL,
			'problem', coalesce(NEW.error, 'The pull job failed')
		))
	WHERE id = (NEW.payload->>'runId')::integer AND status IN ('queued', 'running');
	RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER jobs_fail_run AFTER UPDATE OF status ON "jobs"
	FOR EACH ROW WHEN (NEW.kind = 'provider.pull' AND NEW.status = 'failed' AND OLD.status <> 'failed')
	EXECUTE FUNCTION fail_run_with_its_job();
