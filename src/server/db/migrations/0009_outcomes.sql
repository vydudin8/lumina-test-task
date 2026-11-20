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
CREATE INDEX "outcome_events_occurred" ON "outcome_events" USING btree ("occurred_at");