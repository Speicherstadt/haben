ALTER TABLE "document_splits" ADD COLUMN "private_share" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_splits" ADD CONSTRAINT "document_splits_private_share_range" CHECK ("document_splits"."private_share" between 0 and 100);--> statement-breakpoint
-- Alte Entwürfe mit Zeilen: Der Anteil am Beleg zählt nicht mehr, der Anteil steht je Zeile (#1914)
UPDATE "documents" SET "private_share" = 0 WHERE "private_share" <> 0 AND EXISTS (SELECT 1 FROM "document_splits" s WHERE s."document_id" = "documents"."id");