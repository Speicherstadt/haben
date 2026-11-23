-- Kennzeichen „Arbeits-, Maschinen- und Fahrtkosten“ je Position und Artikel (#712, § 35a EStG). Nur Spalten mit
-- Standardwert: Festgeschriebene Positionen behalten false, ihr Blatt bleibt gleich, und die Integritätsprüfung für
-- ältere Siegel (0310) findet an ihnen den Standardwert.
ALTER TABLE "articles" ADD COLUMN "arbeitskosten" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "arbeitskosten" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "arbeitskosten" boolean DEFAULT false NOT NULL;