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
ALTER TABLE "score_rationales" ADD CONSTRAINT "score_rationales_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_rationales" ADD CONSTRAINT "score_rationales_icp_version_id_icp_versions_id_fk" FOREIGN KEY ("icp_version_id") REFERENCES "public"."icp_versions"("id") ON DELETE no action ON UPDATE no action;