CREATE TABLE "companies" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "companies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_raw_record_id_raw_records_id_fk" FOREIGN KEY ("raw_record_id") REFERENCES "public"."raw_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_source_company_id_source_companies_id_fk" FOREIGN KEY ("source_company_id") REFERENCES "public"."source_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_overrides" ADD CONSTRAINT "field_overrides_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_overrides" ADD CONSTRAINT "field_overrides_chosen_source_id_source_companies_id_fk" FOREIGN KEY ("chosen_source_id") REFERENCES "public"."source_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_overrides" ADD CONSTRAINT "field_overrides_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_decisions" ADD CONSTRAINT "match_decisions_source_a_source_companies_id_fk" FOREIGN KEY ("source_a") REFERENCES "public"."source_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_decisions" ADD CONSTRAINT "match_decisions_source_b_source_companies_id_fk" FOREIGN KEY ("source_b") REFERENCES "public"."source_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_decisions" ADD CONSTRAINT "match_decisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_companies" ADD CONSTRAINT "source_companies_raw_record_id_raw_records_id_fk" FOREIGN KEY ("raw_record_id") REFERENCES "public"."raw_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_companies" ADD CONSTRAINT "source_companies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_companies" ADD CONSTRAINT "source_companies_fx_rate_id_fx_rates_id_fk" FOREIGN KEY ("fx_rate_id") REFERENCES "public"."fx_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contacts_person_key" ON "contacts" USING btree ("person_key");--> statement-breakpoint
CREATE INDEX "contacts_person_key_hash" ON "contacts" USING btree ("person_key_hash");--> statement-breakpoint
CREATE INDEX "contacts_source_company" ON "contacts" USING btree ("source_company_id");--> statement-breakpoint
CREATE INDEX "source_companies_company" ON "source_companies" USING btree ("company_id");