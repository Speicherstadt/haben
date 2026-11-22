-- Wiederkehrende Rechnungen auch wöchentlich und alle zwei Wochen (#1691): bestehende Vorlagen bleiben bei Monaten
ALTER TABLE "recurring_invoices" DROP CONSTRAINT "recurring_interval";--> statement-breakpoint
ALTER TABLE "recurring_invoices" ALTER COLUMN "interval_months" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD COLUMN "interval_weeks" smallint;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_interval" CHECK (("recurring_invoices"."interval_months" in (1, 3, 6, 12) and "recurring_invoices"."interval_weeks" is null) or ("recurring_invoices"."interval_months" is null and "recurring_invoices"."interval_weeks" in (1, 2)));