-- Intervall wiederkehrender Rechnungen als Dauer nach ISO 8601 statt in Monaten (#1691): neu auch Wochen und 2 Monate.
-- Bestehende Vorlagen behalten ihr Intervall: 1, 3, 6 Monate werden P1M, P3M, P6M, 12 Monate P1Y.
SELECT set_config('haben.actor', 'system:migration', true);--> statement-breakpoint
ALTER TABLE "recurring_invoices" DROP CONSTRAINT "recurring_interval";--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD COLUMN "recurrence" text;--> statement-breakpoint
UPDATE "recurring_invoices" SET "recurrence" = CASE "interval_months" WHEN 12 THEN 'P1Y' ELSE 'P' || "interval_months" || 'M' END;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ALTER COLUMN "recurrence" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_invoices" DROP COLUMN "interval_months";--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_recurrence" CHECK ("recurring_invoices"."recurrence" in ('P1W', 'P2W', 'P4W', 'P1M', 'P2M', 'P3M', 'P6M', 'P1Y'));
