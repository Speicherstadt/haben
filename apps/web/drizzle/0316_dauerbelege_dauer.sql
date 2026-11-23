-- Intervall der Dauerbelege als Dauer nach ISO 8601 wie bei wiederkehrenden Rechnungen (0315, #1691): neu auch Wochen und
-- 2 Monate. Bestehende Vorlagen behalten ihr Intervall: 1, 3, 6 Monate werden P1M, P3M, P6M, 12 Monate P1Y.
SELECT set_config('haben.actor', 'system:migration', true);--> statement-breakpoint
ALTER TABLE "recurring_documents" DROP CONSTRAINT "recurring_documents_interval";--> statement-breakpoint
ALTER TABLE "recurring_documents" ADD COLUMN "recurrence" text;--> statement-breakpoint
UPDATE "recurring_documents" SET "recurrence" = CASE "interval_months" WHEN 12 THEN 'P1Y' ELSE 'P' || "interval_months" || 'M' END;--> statement-breakpoint
ALTER TABLE "recurring_documents" ALTER COLUMN "recurrence" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_documents" DROP COLUMN "interval_months";--> statement-breakpoint
ALTER TABLE "recurring_documents" ADD CONSTRAINT "recurring_documents_recurrence" CHECK ("recurring_documents"."recurrence" in ('P1W', 'P2W', 'P4W', 'P1M', 'P2M', 'P3M', 'P6M', 'P1Y'));
