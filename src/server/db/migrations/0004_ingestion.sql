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
	CONSTRAINT "ingestion_runs_status" CHECK ("ingestion_runs"."status" IN ('running', 'succeeded', 'succeeded_with_errors', 'failed')),
	CONSTRAINT "ingestion_runs_provider" CHECK ("ingestion_runs"."provider" IN ('apollo', 'factset', 'clay'))
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
ALTER TABLE "raw_records" ADD CONSTRAINT "raw_records_run_id_ingestion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_records" ADD CONSTRAINT "raw_records_last_seen_run_id_ingestion_runs_id_fk" FOREIGN KEY ("last_seen_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingestion_runs_provider_started" ON "ingestion_runs" USING btree ("provider","started_at");--> statement-breakpoint
CREATE INDEX "raw_records_latest" ON "raw_records" USING btree ("provider","kind","external_id","fetched_at");