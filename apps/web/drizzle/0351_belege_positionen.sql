-- Positionen als einzige Kontierung der Belege (#1975, docs/adr/belege-positionen.md): Offene Belege ohne Zeilen bekommen
-- je Steuersatz eine Position mit Kategorie und eigenem Konto des Belegs; ein Privatanteil wird je Satz eine Position
-- „privatentnahme“ mit dem privaten Teil von Netto und Steuer. Gerundet wie belegAnteile in packages/core: privat
-- kaufmännisch (round auf numeric rundet halbe Cent von der Null weg wie roundHalfAwayFromZero), betrieblich der Rest; so
-- bucht der Beleg auf jedem Konto wie vorher (positionen-migration.test.ts). Ein Entwurf mit Kategorie, aber ohne
-- Beträge bekommt eine Position zu 19 % mit 0, damit die Kategorie bleibt. Danach stehen Kategorie, eigenes Konto und
-- Privatanteil nur noch in den Positionen.
--
-- Nicht berührt: gebuchte Belege (gesperrt und versiegelt; Haben liest sie als eine Position je Satz) und offene Belege, die
-- schon aufgeteilt sind; deren Privatanteil am Beleg ließ sich mit Aufteilung nie buchen und bleibt sichtbar stehen.
SELECT set_config('haben.actor', 'system:migration', true);--> statement-breakpoint
CREATE TEMP TABLE haben_0351_offen ON COMMIT DROP AS
  SELECT d.id, d.category, d.own_account_id, d.private_share, d.currency <> 'EUR' AS fremd
    FROM documents d
   WHERE d.locked_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM document_splits s WHERE s.document_id = d.id)
     AND (d.category IS NOT NULL OR EXISTS (SELECT 1 FROM document_amounts a WHERE a.document_id = d.id));--> statement-breakpoint
INSERT INTO document_splits (document_id, position, category, own_account_id, tax_rate, net, tax, original_net)
WITH saetze AS (
  SELECT o.id, o.category, o.own_account_id, a.tax_rate, a.net, a.tax,
         round(a.net::numeric * o.private_share / 100)::integer AS privat_net,
         round(a.tax::numeric * o.private_share / 100)::integer AS privat_tax,
         CASE WHEN o.fremd THEN coalesce(a.original_net, 0) END AS original_net,
         CASE WHEN o.fremd THEN round(coalesce(a.original_net, 0)::numeric * o.private_share / 100)::bigint END AS privat_original
    FROM haben_0351_offen o JOIN document_amounts a ON a.document_id = o.id
), zeilen AS (
  SELECT id, tax_rate, 0 AS art, category, own_account_id, net - privat_net AS net, tax - privat_tax AS tax, original_net - privat_original AS original_net
    FROM saetze
  UNION ALL
  SELECT id, tax_rate, 1, 'privatentnahme', NULL, privat_net, privat_tax, privat_original FROM saetze
   WHERE privat_net <> 0 OR privat_tax <> 0 OR coalesce(privat_original, 0) <> 0
  UNION ALL
  SELECT o.id, 1900, 0, o.category, o.own_account_id, 0, 0, CASE WHEN o.fremd THEN 0 END FROM haben_0351_offen o
   WHERE NOT EXISTS (SELECT 1 FROM document_amounts a WHERE a.document_id = o.id)
)
SELECT id, row_number() OVER (PARTITION BY id ORDER BY tax_rate DESC, art), category, own_account_id, tax_rate, net, tax, original_net FROM zeilen;--> statement-breakpoint
UPDATE documents d SET category = NULL, own_account_id = NULL, private_share = 0
  FROM haben_0351_offen o
 WHERE d.id = o.id AND (d.category IS NOT NULL OR d.own_account_id IS NOT NULL OR d.private_share <> 0);--> statement-breakpoint
SELECT set_config('haben.actor', '', true);
