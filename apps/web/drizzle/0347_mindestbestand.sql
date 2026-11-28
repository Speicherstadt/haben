ALTER TABLE "company" ADD COLUMN "mindestbestand" bigint;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_mindestbestand" CHECK ("company"."mindestbestand" >= 0);