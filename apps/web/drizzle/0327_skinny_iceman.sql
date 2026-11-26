ALTER TABLE "document_splits" ADD COLUMN "private_share" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_splits" ADD CONSTRAINT "document_splits_private_share_range" CHECK ("document_splits"."private_share" between 0 and 100);--> statement-breakpoint
-- Alte Entwürfe mit Zeilen: Der Anteil am Beleg zählt nicht mehr, der Anteil steht je Zeile (#1914). Damit er nicht
-- stumm verloren geht, übernimmt ihn die Zeile mit der kleinsten Position. Festschriebene Belege bleiben unberührt; ihr
-- Trigger (documents_locked) weist jede Änderung ab.
UPDATE "document_splits" SET "private_share" = d."private_share"
  FROM "documents" d
  WHERE d."id" = "document_splits"."document_id"
    AND d."locked_at" IS NULL
    AND d."private_share" > 0
    AND "document_splits"."position" = (SELECT min(s."position") FROM "document_splits" s WHERE s."document_id" = d."id");--> statement-breakpoint
UPDATE "documents" SET "private_share" = 0
  WHERE "private_share" <> 0
    AND "locked_at" IS NULL
    AND EXISTS (SELECT 1 FROM "document_splits" s WHERE s."document_id" = "documents"."id");
