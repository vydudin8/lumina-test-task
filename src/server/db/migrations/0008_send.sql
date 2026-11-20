CREATE TABLE "mail_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mail_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"provider_event_id" text,
	"mail_id" text,
	"status" text,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"signature_ok" boolean NOT NULL,
	CONSTRAINT "mail_events_providerEventId_unique" UNIQUE("provider_event_id"),
	CONSTRAINT "mail_events_verified_id" CHECK ("mail_events"."signature_ok" OR "mail_events"."provider_event_id" IS NULL)
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
ALTER TABLE "cards" ADD COLUMN "send_error" text;--> statement-breakpoint
ALTER TABLE "submission_attempts" ADD CONSTRAINT "submission_attempts_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_events_mail_id" ON "mail_events" USING btree ("mail_id");