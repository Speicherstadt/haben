CREATE TABLE "inbox_outgoing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sha256" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"sender" text NOT NULL,
	"subject" text NOT NULL,
	"received_at" timestamp with time zone,
	"status" text DEFAULT 'offen' NOT NULL,
	"invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_outgoing_sha256_unique" UNIQUE("sha256")
);
--> statement-breakpoint
ALTER TABLE "inbox_outgoing" ADD CONSTRAINT "inbox_outgoing_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;