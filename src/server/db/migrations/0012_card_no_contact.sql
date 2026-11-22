ALTER TABLE "cards" ALTER COLUMN "contact_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "person_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "recipient" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_recipient_present" CHECK (("cards"."contact_id" IS NULL) = ("cards"."block_reason" IS NOT DISTINCT FROM 'no_contact') AND ("cards"."person_key" IS NULL) = ("cards"."contact_id" IS NULL) AND ("cards"."recipient" IS NULL) = ("cards"."contact_id" IS NULL));