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
CREATE TABLE "seed_runs" (
	"version" integer PRIMARY KEY NOT NULL,
	"checksum" text NOT NULL,
	"at" timestamp with time zone NOT NULL
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
	"variant" text NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "templates_name_unique" UNIQUE("name"),
	CONSTRAINT "templates_variant" CHECK ("templates"."variant" IN ('A', 'B'))
);
--> statement-breakpoint
ALTER TABLE "icp_versions" ADD CONSTRAINT "icp_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;