CREATE TABLE "campaigns" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "campaigns_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"name" text NOT NULL,
	"icp_version_id" integer NOT NULL,
	"top_n" integer NOT NULL,
	"template_a_id" integer NOT NULL,
	"template_b_id" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"launched_by" text,
	"launched_by_role" "user_role",
	"launched_at" timestamp with time zone,
	CONSTRAINT "campaigns_idempotencyKey_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "campaigns_status" CHECK ("campaigns"."status" IN ('draft', 'sending', 'sent')),
	CONSTRAINT "campaigns_launcher_is_lead" CHECK ("campaigns"."launched_by_role" IS NULL OR "campaigns"."launched_by_role" = 'lead'),
	CONSTRAINT "campaigns_launch_recorded" CHECK (("campaigns"."status" = 'draft') = ("campaigns"."launched_at" IS NULL) AND ("campaigns"."launched_at" IS NULL) = ("campaigns"."launched_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cards_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"campaign_id" integer NOT NULL,
	"company_id" integer NOT NULL,
	"contact_id" integer NOT NULL,
	"person_key" text NOT NULL,
	"rank" integer NOT NULL,
	"score" numeric NOT NULL,
	"score_display" integer NOT NULL,
	"contributions" jsonb NOT NULL,
	"recipient" jsonb NOT NULL,
	"address" jsonb,
	"eligibility" text NOT NULL,
	"block_reason" text,
	"variant" text,
	"personal_line" text NOT NULL,
	"line_source" text NOT NULL,
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
	"submitted_at" timestamp with time zone,
	"mailed_at" timestamp with time zone,
	"status_changed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cards_idempotencyKey_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "cards_mailId_unique" UNIQUE("mail_id"),
	CONSTRAINT "cards_campaign_company" UNIQUE("campaign_id","company_id"),
	CONSTRAINT "cards_status" CHECK (status IN ('draft', 'approved', 'rejected', 'blocked', 'queued', 'submitted', 'printed', 'mailed', 'delivered', 'returned', 'blocked_at_send', 'failed')),
	CONSTRAINT "cards_eligibility" CHECK ("cards"."eligibility" IN ('eligible', 'blocked')),
	CONSTRAINT "cards_blocked_at_build" CHECK (("cards"."eligibility" = 'blocked') = ("cards"."status" = 'blocked')),
	CONSTRAINT "cards_block_reason" CHECK (("cards"."status" IN ('blocked', 'blocked_at_send')) = ("cards"."block_reason" IS NOT NULL)),
	CONSTRAINT "cards_reject_reason" CHECK (("cards"."status" = 'rejected') = (btrim(coalesce("cards"."reject_reason", '')) <> '')),
	CONSTRAINT "cards_variant" CHECK (("cards"."eligibility" = 'eligible') = ("cards"."variant" IN ('A', 'B'))),
	CONSTRAINT "cards_approval_recorded" CHECK ("cards"."status" IN ('draft', 'rejected', 'blocked') OR ("cards"."approved_by" IS NOT NULL AND "cards"."approved_at" IS NOT NULL AND "cards"."idempotency_key" IS NOT NULL)),
	CONSTRAINT "cards_approver_is_lead" CHECK ("cards"."approved_by_role" IS NULL OR "cards"."approved_by_role" = 'lead')
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_icp_version_id_icp_versions_id_fk" FOREIGN KEY ("icp_version_id") REFERENCES "public"."icp_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_a_id_templates_id_fk" FOREIGN KEY ("template_a_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_b_id_templates_id_fk" FOREIGN KEY ("template_b_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_launched_by_user_role" FOREIGN KEY ("launched_by","launched_by_role") REFERENCES "public"."users"("id","role") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_approved_by_user_role" FOREIGN KEY ("approved_by","approved_by_role") REFERENCES "public"."users"("id","role") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cards_person_key" ON "cards" USING btree ("person_key","submitted_at");