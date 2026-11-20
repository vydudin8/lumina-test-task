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
	CONSTRAINT "audit_reason_required" CHECK (("audit_events"."decision" IS DISTINCT FROM 'rejected' AND "audit_events"."action" NOT IN ('company.merged', 'company.unmerged', 'field.overridden')) OR btrim(coalesce("audit_events"."reason", '')) <> '')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" NOT NULL,
	CONSTRAINT "users_id_role" UNIQUE("id","role")
);
--> statement-breakpoint
CREATE INDEX "audit_events_entity" ON "audit_events" USING btree ("entity_type","entity_id","at");--> statement-breakpoint
CREATE INDEX "audit_events_at" ON "audit_events" USING btree ("at");