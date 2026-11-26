-- #1926: Der Privatanteil einer Zeile kann ein absoluter Betrag sein, wahlweise netto oder brutto (etwa Netflix
-- vollständig privat auf einer Telekom-Rechnung). Nur zwei nullable Spalten, kein Tabellenumschreiben; Bestandszeilen
-- behalten ihren Prozentwert. Betrag und Basis gehören zusammen, höchstens eine Angabe je Zeile, kein negativer Betrag.
ALTER TABLE "document_splits" ADD COLUMN "private_amount" integer;--> statement-breakpoint
ALTER TABLE "document_splits" ADD COLUMN "private_amount_basis" text;--> statement-breakpoint
ALTER TABLE "document_splits" ADD CONSTRAINT "document_splits_private_amount_nicht_negativ" CHECK ("document_splits"."private_amount" >= 0);--> statement-breakpoint
ALTER TABLE "document_splits" ADD CONSTRAINT "document_splits_private_amount_basis" CHECK ("document_splits"."private_amount_basis" in ('netto', 'brutto'));--> statement-breakpoint
ALTER TABLE "document_splits" ADD CONSTRAINT "document_splits_private_amount_paar" CHECK (("document_splits"."private_amount" is null) = ("document_splits"."private_amount_basis" is null));--> statement-breakpoint
ALTER TABLE "document_splits" ADD CONSTRAINT "document_splits_privat_eine_angabe" CHECK (not ("document_splits"."private_share" > 0 and "document_splits"."private_amount" is not null));