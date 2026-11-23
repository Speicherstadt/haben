-- Standard-Textbaustein je Mahnstufe (#1678) statt einem für alle Mahnungen
ALTER TABLE "text_blocks" DROP CONSTRAINT "text_blocks_standard_fuer";--> statement-breakpoint
-- Der Standard „Mahnung“ aus 0313 galt für jede Stufe: Er wird Standard der 1. Mahnung, Zahlungserinnerung und letzte
-- Mahnung bekommen je eine Kopie, damit jede Stufe ihren Text behält (wie stammdaten/uebernahme.ts für ältere Exporte).
-- Der Name der Kopie bleibt bei 200 UTF-16-Einheiten wie im Formular: je Zeichen außerhalb der BMP ein Zeichen weniger
SELECT set_config('haben.actor', 'system:migration', true);--> statement-breakpoint
INSERT INTO "text_blocks" ("name", "kind", "text", "standard_fuer")
  SELECT left("name", greatest(179 - (char_length("name") - char_length(regexp_replace("name", '[\U00010000-\U0010FFFF]', '', 'g'))), 0)) || ' (Zahlungserinnerung)', "kind", "text", 'mahnstufe_1' FROM "text_blocks" WHERE "standard_fuer" = 'mahnung' AND "archived_at" IS NULL;--> statement-breakpoint
INSERT INTO "text_blocks" ("name", "kind", "text", "standard_fuer")
  SELECT left("name", greatest(183 - (char_length("name") - char_length(regexp_replace("name", '[\U00010000-\U0010FFFF]', '', 'g'))), 0)) || ' (Letzte Mahnung)', "kind", "text", 'mahnstufe_3' FROM "text_blocks" WHERE "standard_fuer" = 'mahnung' AND "archived_at" IS NULL;--> statement-breakpoint
UPDATE "text_blocks" SET "standard_fuer" = CASE WHEN "archived_at" IS NULL THEN 'mahnstufe_2' END, "updated_at" = now() WHERE "standard_fuer" = 'mahnung';--> statement-breakpoint
SELECT set_config('haben.actor', '', true);--> statement-breakpoint
ALTER TABLE "text_blocks" ADD CONSTRAINT "text_blocks_standard_fuer" CHECK ("text_blocks"."standard_fuer" is null or "text_blocks"."standard_fuer" in ('rechnung', 'angebot', 'auftragsbestaetigung', 'lieferschein', 'mahnstufe_1', 'mahnstufe_2', 'mahnstufe_3'));
