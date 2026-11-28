ALTER TABLE "document_splits" ALTER COLUMN "category" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "document_splits" ADD COLUMN "original_net" bigint;