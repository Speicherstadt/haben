-- Festgeschriebene Angebote und gebuchte Anlagen versiegeln (#2039). Trigger sperren beide, aber mit abgeschalteten
-- Triggern ließen sich etwa Betrag und Positionen eines Angebots oder die Anschaffungskosten einer gebuchten Anlage ändern,
-- ohne dass haben_integrity_problems etwas meldete.
--
-- 1. Angebote: Siegel beim Festschreiben wie bei Rechnungen, über quotes ohne Entscheidung, Entscheidungszeitpunkt, Rechnung
--    und updated_at, samt Positionen, Anhängen und PDF. Positionen bekommen einen Audit-Trigger.
-- 2. Anlagen: Siegel bei der ersten Buchung (erste AfA oder Eröffnungsbuchung) über die dann festen Spalten.
-- 3. haben_integrity_problems prüft beide wie die übrigen versiegelten Tabellen.
-- 4. Bestand: Festgeschriebene Angebote und gebuchte Anlagen bekommen ein Siegel mit genesis = true wie in 0064.
--
-- Entscheidung des Maintainers in #2039. Quelle: GoBD, BMF-Schreiben vom 28.11.2019, Rz. 108 (keine Änderung ohne
-- Kenntlichmachung), am Original gelesen in #861.
SELECT set_config('haben.actor', 'system:migration', true);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION haben_seal_columns(tbl text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT CASE tbl
    WHEN 'journal_entries' THEN jsonb_build_object(
      'journal_entries', haben_columns('journal_entries'), 'journal_lines', haben_columns('journal_lines'))
    WHEN 'invoices' THEN jsonb_build_object(
      'invoices', haben_columns('invoices'), 'invoice_lines', haben_columns('invoice_lines'),
      'invoice_taxes', haben_columns('invoice_taxes'), 'invoice_attachments', haben_columns('invoice_attachments'))
    WHEN 'documents' THEN jsonb_build_object(
      'documents', haben_columns('documents'), 'document_amounts', haben_columns('document_amounts'),
      'document_splits', haben_columns('document_splits'))
    WHEN 'vat_returns' THEN jsonb_build_object(
      'vat_returns', haben_columns('vat_returns'), 'vat_return_filings', haben_columns('vat_return_filings'))
    WHEN 'cash_entries' THEN jsonb_build_object('cash_entries', haben_columns('cash_entries'))
    WHEN 'allocations' THEN jsonb_build_object('allocations', haben_columns('allocations'))
    WHEN 'pauschalen' THEN jsonb_build_object('pauschalen', haben_columns('pauschalen'))
    WHEN 'asset_depreciations' THEN jsonb_build_object('asset_depreciations', haben_columns('asset_depreciations'))
    WHEN 'document_cancellations' THEN jsonb_build_object('document_cancellations', haben_columns('document_cancellations'))
    WHEN 'payslips' THEN jsonb_build_object('payslips', haben_columns('payslips'))
    WHEN 'payslip_cancellations' THEN jsonb_build_object('payslip_cancellations', haben_columns('payslip_cancellations'))
    -- Ohne die Spalten, die nach dem Festschreiben änderbar bleiben (haben_reject_locked_quote, 0044)
    WHEN 'quotes' THEN jsonb_build_object(
      'quotes', haben_columns('quotes') - ARRAY['decision', 'decided_at', 'invoice_id', 'updated_at'],
      'quote_lines', haben_columns('quote_lines'), 'quote_attachments', haben_columns('quote_attachments'))
    -- Nur die Spalten, die ab der ersten Buchung fest sind (haben_reject_booked_asset, 0342), als feste Liste: Eine spätere
    -- Spalte kommt nicht von selbst dazu, weil Name, Notiz, Abgang und Sonder-AfA späterer Jahre änderbar bleiben. Den
    -- Verweis auf die Eröffnungsbuchung setzt die App vor der ersten AfA; ohne Übernahmewerte bleibt er leer.
    WHEN 'assets' THEN jsonb_build_object('assets', jsonb_build_array('id', 'kind', 'method', 'account', 'acquisition_date', 'cost',
      'useful_life_months', 'document_id', 'opening_date', 'opening_book_value', 'opening_entry_id', 'private_use',
      'degressive_rate', 'memo_value'))
  END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION haben_seal_digest(tbl text, rid uuid, cols jsonb) RETURNS text
LANGUAGE plpgsql STABLE
SET TimeZone = 'UTC' SET bytea_output = 'hex' SET IntervalStyle = 'postgres' SET extra_float_digits = 1
AS $$
DECLARE
  content jsonb;
BEGIN
  CASE tbl
    WHEN 'journal_entries' THEN
      content := jsonb_build_object(
        'journal_entries', (SELECT haben_pick(to_jsonb(e), cols -> 'journal_entries') FROM journal_entries e WHERE e.id = rid),
        'journal_lines', (SELECT coalesce(jsonb_agg(haben_pick(to_jsonb(l), cols -> 'journal_lines') ORDER BY l.id), '[]'::jsonb)
                            FROM journal_lines l WHERE l.entry_id = rid));
    WHEN 'invoices' THEN
      content := jsonb_build_object(
        'invoices', (SELECT haben_pick(to_jsonb(i), cols -> 'invoices') FROM invoices i WHERE i.id = rid),
        'invoice_lines', (SELECT coalesce(jsonb_agg(haben_pick(to_jsonb(l), cols -> 'invoice_lines') ORDER BY l.id), '[]'::jsonb)
                            FROM invoice_lines l WHERE l.invoice_id = rid),
        'invoice_taxes', (SELECT coalesce(jsonb_agg(haben_pick(to_jsonb(t), cols -> 'invoice_taxes') ORDER BY t.rate), '[]'::jsonb)
                            FROM invoice_taxes t WHERE t.invoice_id = rid))
        -- Nur Siegel ab 0125 kennen die Anhänge; ältere Siegel ergeben so denselben Inhalt wie bisher
        || CASE WHEN cols ? 'invoice_attachments' THEN jsonb_build_object(
             'invoice_attachments', (SELECT coalesce(jsonb_agg(haben_pick(to_jsonb(a), cols -> 'invoice_attachments') ORDER BY a.id), '[]'::jsonb)
                                       FROM invoice_attachments a WHERE a.invoice_id = rid))
           ELSE '{}'::jsonb END;
    WHEN 'documents' THEN
      content := jsonb_build_object(
        'documents', (SELECT haben_pick(to_jsonb(d), cols -> 'documents') FROM documents d WHERE d.id = rid),
        'document_amounts', (SELECT coalesce(jsonb_agg(haben_pick(to_jsonb(a), cols -> 'document_amounts') ORDER BY a.id), '[]'::jsonb)
                               FROM document_amounts a WHERE a.document_id = rid));
      -- Aufteilung (#271) nur in Siegeln, deren Spaltenliste sie nennt: Ältere Siegel behalten ihren Hash
      IF cols ? 'document_splits' THEN
        content := content || jsonb_build_object(
          'document_splits', (SELECT coalesce(jsonb_agg(haben_pick(to_jsonb(s), cols -> 'document_splits') ORDER BY s.position), '[]'::jsonb)
                                FROM document_splits s WHERE s.document_id = rid));
      END IF;
    WHEN 'vat_returns' THEN
      content := jsonb_build_object(
        'vat_returns', (SELECT haben_pick(to_jsonb(v), cols -> 'vat_returns') FROM vat_returns v WHERE v.id = rid));
      -- Abgabevermerk nur in Siegeln, deren Spaltenliste ihn nennt: Ältere Siegel behalten ihren Hash
      IF cols ? 'vat_return_filings' THEN
        content := content || jsonb_build_object(
          'vat_return_filings', (SELECT coalesce(jsonb_agg(haben_pick(to_jsonb(f), cols -> 'vat_return_filings') ORDER BY f.id), '[]'::jsonb)
                                   FROM vat_return_filings f WHERE f.vat_return_id = rid));
      END IF;
    WHEN 'cash_entries' THEN
      content := jsonb_build_object(
        'cash_entries', (SELECT haben_pick(to_jsonb(c), cols -> 'cash_entries') FROM cash_entries c WHERE c.id = rid));
    WHEN 'allocations' THEN
      content := jsonb_build_object(
        'allocations', (SELECT haben_pick(to_jsonb(a), cols -> 'allocations') FROM allocations a WHERE a.id = rid));
    WHEN 'pauschalen' THEN
      content := jsonb_build_object(
        'pauschalen', (SELECT haben_pick(to_jsonb(p), cols -> 'pauschalen') FROM pauschalen p WHERE p.id = rid));
    WHEN 'asset_depreciations' THEN
      content := jsonb_build_object(
        'asset_depreciations', (SELECT haben_pick(to_jsonb(d), cols -> 'asset_depreciations') FROM asset_depreciations d WHERE d.id = rid));
    WHEN 'document_cancellations' THEN
      content := jsonb_build_object(
        'document_cancellations', (SELECT haben_pick(to_jsonb(c), cols -> 'document_cancellations') FROM document_cancellations c WHERE c.id = rid));
    WHEN 'payslips' THEN
      content := jsonb_build_object(
        'payslips', (SELECT haben_pick(to_jsonb(p), cols -> 'payslips') FROM payslips p WHERE p.id = rid));
    WHEN 'payslip_cancellations' THEN
      content := jsonb_build_object(
        'payslip_cancellations', (SELECT haben_pick(to_jsonb(c), cols -> 'payslip_cancellations') FROM payslip_cancellations c WHERE c.id = rid));
    WHEN 'quotes' THEN
      content := jsonb_build_object(
        'quotes', (SELECT haben_pick(to_jsonb(q), cols -> 'quotes') FROM quotes q WHERE q.id = rid),
        'quote_lines', (SELECT coalesce(jsonb_agg(haben_pick(to_jsonb(l), cols -> 'quote_lines') ORDER BY l.id), '[]'::jsonb)
                          FROM quote_lines l WHERE l.quote_id = rid),
        'quote_attachments', (SELECT coalesce(jsonb_agg(haben_pick(to_jsonb(a), cols -> 'quote_attachments') ORDER BY a.id), '[]'::jsonb)
                                FROM quote_attachments a WHERE a.quote_id = rid));
    WHEN 'assets' THEN
      content := jsonb_build_object(
        'assets', (SELECT haben_pick(to_jsonb(a), cols -> 'assets') FROM assets a WHERE a.id = rid));
    ELSE
      RAISE EXCEPTION 'Für % gibt es kein Siegel', tbl;
  END CASE;
  RETURN encode(sha256(convert_to(content::text, 'UTF8')), 'hex');
END;
$$;
--> statement-breakpoint
CREATE TRIGGER quote_lines_audit AFTER INSERT OR UPDATE OR DELETE ON quote_lines
  FOR EACH ROW EXECUTE FUNCTION haben_audit();
--> statement-breakpoint
-- Positionen und Anhänge stehen beim Festschreiben schon fest: danach lehnen ihre Trigger jede Änderung ab (0044, 0164).
CREATE TRIGGER quotes_seal AFTER UPDATE OF locked_at ON quotes
  FOR EACH ROW WHEN (OLD.locked_at IS NULL AND NEW.locked_at IS NOT NULL) EXECUTE FUNCTION haben_seal();
--> statement-breakpoint
CREATE TRIGGER quotes_seal_insert AFTER INSERT ON quotes
  FOR EACH ROW WHEN (NEW.locked_at IS NOT NULL) EXECUTE FUNCTION haben_seal();
--> statement-breakpoint
-- Siegel einer Anlage bei ihrer ersten Buchung: mit der ersten AfA oder der Eröffnungsbuchung, je nachdem, was zuerst kommt.
-- Eine Anlage hat höchstens ein Siegel (seals_row); jede weitere Buchung lässt es, wie es ist.
CREATE FUNCTION haben_seal_asset() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  aid uuid;
  cols jsonb;
BEGIN
  -- Getrennte Zuweisungen: plpgsql löst NEW.asset_id erst auf, wenn die Zeile läuft, und assets hat die Spalte nicht
  IF TG_TABLE_NAME = 'assets' THEN
    aid := NEW.id;
  ELSE
    aid := NEW.asset_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM seals WHERE table_name = 'assets' AND row_id = aid) THEN
    cols := haben_seal_columns('assets');
    INSERT INTO seals (table_name, row_id, columns, digest, genesis, created_at)
    VALUES ('assets', aid, cols, haben_seal_digest('assets', aid, cols), false, now())
    ON CONFLICT (table_name, row_id) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER assets_seal AFTER INSERT OR UPDATE OF opening_entry_id ON assets
  FOR EACH ROW WHEN (NEW.opening_entry_id IS NOT NULL) EXECUTE FUNCTION haben_seal_asset();
--> statement-breakpoint
CREATE TRIGGER asset_depreciations_seal_asset AFTER INSERT ON asset_depreciations
  FOR EACH ROW EXECUTE FUNCTION haben_seal_asset();
--> statement-breakpoint
-- Bestand nachträglich versiegeln
INSERT INTO seals (table_name, row_id, columns, digest, genesis)
SELECT tbl, id, haben_seal_columns(tbl), haben_seal_digest(tbl, id, haben_seal_columns(tbl)), true
  FROM (
    SELECT 'quotes' AS tbl, q.id, q.locked_at AS seit FROM quotes q WHERE q.locked_at IS NOT NULL
    UNION ALL
    SELECT 'assets', a.id, a.created_at FROM assets a
     WHERE EXISTS (SELECT 1 FROM asset_depreciations d WHERE d.asset_id = a.id) OR a.opening_entry_id IS NOT NULL
  ) existing
 WHERE NOT EXISTS (SELECT 1 FROM seals s WHERE s.table_name = existing.tbl AND s.row_id = existing.id)
 ORDER BY seit, tbl, id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION haben_integrity_problems(max_rows integer DEFAULT 100)
RETURNS TABLE (art text, tabelle text, zeile text, seq bigint, befund text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  tbl text;
  locked text;
  heute jsonb;
  listen jsonb;
  teil text;
  fk text;
  fehlend text[];
  spalte text;
  ausdruck text;
  wert jsonb;
  standard jsonb;
  werte text;
  unauswertbar text[];
BEGIN
  RETURN QUERY
  SELECT 'kette'::text, 'audit_log'::text, c.id::text, c.seq,
    CASE
      WHEN c.seq <> coalesce(c.before_seq, 0) + 1 THEN format('Lücke: auf Eintrag %s folgt %s', coalesce(c.before_seq, 0), c.seq)
      WHEN c.prev_hash IS DISTINCT FROM coalesce(c.before_hash, haben_audit_genesis()) THEN 'Verweis auf den Vorgänger passt nicht'
      ELSE 'Inhalt passt nicht zum Hash'
    END
  FROM (
    SELECT a.id, a.seq, a.prev_hash, a.row_hash, haben_audit_hash(a.prev_hash, a) AS calc,
           lag(a.seq) OVER w AS before_seq, lag(a.row_hash) OVER w AS before_hash
      FROM audit_log a
    WINDOW w AS (ORDER BY a.seq)
  ) c
  WHERE c.seq <> coalesce(c.before_seq, 0) + 1
     OR c.prev_hash IS DISTINCT FROM coalesce(c.before_hash, haben_audit_genesis())
     OR c.row_hash IS DISTINCT FROM c.calc
  ORDER BY c.seq
  LIMIT max_rows;

  RETURN QUERY
  SELECT 'kopf'::text, 'audit_chain'::text, NULL::text, h.seq,
    CASE
      WHEN h.id IS NULL THEN 'Kopf der Kette fehlt'
      WHEN last.seq IS DISTINCT FROM h.seq THEN format('Kopf steht bei %s, das Audit-Log endet bei %s', h.seq, last.seq)
      ELSE 'Kopf passt nicht zum letzten Eintrag'
    END
  FROM (SELECT 1) one
  LEFT JOIN audit_chain h ON true
  LEFT JOIN LATERAL (SELECT a.seq, a.row_hash FROM audit_log a ORDER BY a.seq DESC LIMIT 1) last ON true
  WHERE h.id IS NULL OR last.seq IS DISTINCT FROM h.seq OR last.row_hash IS DISTINCT FROM h.hash;

  FOREACH tbl IN ARRAY ARRAY['journal_entries', 'invoices', 'documents', 'vat_returns', 'cash_entries',
                             'allocations', 'pauschalen', 'asset_depreciations', 'document_cancellations',
                             'payslips', 'payslip_cancellations', 'quotes', 'assets'] LOOP
    locked := CASE WHEN tbl IN ('cash_entries', 'allocations', 'pauschalen', 'asset_depreciations', 'document_cancellations',
                                'payslip_cancellations') THEN 'true'
                   -- Gebucht wie in haben_reject_booked_asset (0342); beides lässt sich nicht zurücknehmen
                   WHEN tbl = 'assets' THEN '(EXISTS (SELECT 1 FROM asset_depreciations d WHERE d.asset_id = t.id) OR t.opening_entry_id IS NOT NULL)'
                   ELSE 't.locked_at IS NOT NULL' END;
    RETURN QUERY EXECUTE format($q$
      (SELECT 'siegel'::text, %1$L::text, s.row_id::text, NULL::bigint,
         CASE
           WHEN t.id IS NULL THEN 'Versiegelter Datensatz fehlt'
           WHEN NOT (%2$s) THEN 'Festschreibung aufgehoben'
           ELSE 'Inhalt passt nicht zum Siegel'
         END
         FROM seals s
         LEFT JOIN %1$I t ON t.id = s.row_id
        WHERE s.table_name = %1$L
          AND (t.id IS NULL OR NOT (%2$s) OR haben_seal_digest(s.table_name, s.row_id, s.columns) <> s.digest)
        ORDER BY s.id
        LIMIT $1)
      UNION ALL
      (SELECT 'siegel'::text, %1$L::text, t.id::text, NULL::bigint, 'Festgeschrieben, aber ohne Siegel'
         FROM %1$I t
        WHERE %2$s
          AND NOT EXISTS (SELECT 1 FROM seals s WHERE s.table_name = %1$L AND s.row_id = t.id)
        ORDER BY t.id
        LIMIT $1)
    $q$, tbl, locked) USING max_rows;

    -- Was ältere Siegel dieser Tabelle nicht abdecken
    heute := haben_seal_columns(tbl);
    SELECT coalesce(jsonb_agg(DISTINCT s.columns), '[]'::jsonb) INTO listen
      FROM seals s WHERE s.table_name = tbl AND s.columns <> heute;
    FOR teil IN SELECT jsonb_object_keys(heute) LOOP
      -- Spalte, über die haben_seal_digest die Zeilen des Datensatzes findet. Eine neue Kindtabelle im Siegel fällt
      -- hier bei jedem Lauf auf, nicht erst auf einer Instanz mit älteren Siegeln.
      fk := CASE
        WHEN teil = tbl THEN 'id'
        WHEN teil = 'journal_lines' THEN 'entry_id'
        WHEN teil IN ('invoice_lines', 'invoice_taxes', 'invoice_attachments') THEN 'invoice_id'
        WHEN teil IN ('document_amounts', 'document_splits') THEN 'document_id'
        WHEN teil = 'vat_return_filings' THEN 'vat_return_id'
        WHEN teil IN ('quote_lines', 'quote_attachments') THEN 'quote_id'
      END;
      IF fk IS NULL THEN
        RAISE EXCEPTION 'Integritätsprüfung kennt % im Siegel von % nicht', teil, tbl;
      END IF;
      -- Ohne abweichende Spaltenliste ist nichts zu prüfen
      CONTINUE WHEN listen = '[]'::jsonb;

      -- Kindtabelle, die das Siegel nicht nennt: keine Zeile zu diesem Datensatz
      RETURN QUERY EXECUTE format($q$
        SELECT 'siegel'::text, %1$L::text, s.row_id::text, NULL::bigint,
               format('Zeile in %%s eingefügt, die das Siegel nicht abdeckt', %2$L)
          FROM seals s
         WHERE s.table_name = %1$L AND NOT s.columns ? %2$L
           AND EXISTS (SELECT 1 FROM %2$I t WHERE t.%3$I = s.row_id)
         ORDER BY s.id
         LIMIT $1
      $q$, tbl, teil, fk) USING max_rows;

      -- Spalten, die mindestens einem Siegel fehlen, mit ihrem Standardwert aus dem Katalog
      SELECT array_agg(DISTINCT c) INTO fehlend
        FROM jsonb_array_elements(listen) alt(liste), jsonb_array_elements_text(heute -> teil) c
       WHERE alt.liste ? teil AND NOT (alt.liste -> teil) ? c;
      CONTINUE WHEN fehlend IS NULL;
      standard := '{}'::jsonb;
      unauswertbar := ARRAY[]::text[];
      FOR spalte, ausdruck IN
        SELECT a.attname::text, format('(%s)::%s', pg_get_expr(d.adbin, d.adrelid), format_type(a.atttypid, a.atttypmod))
          FROM pg_attribute a
          JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = teil::regclass AND a.attname = ANY (fehlend)
      LOOP
        BEGIN
          EXECUTE format('SELECT to_jsonb(%s)', ausdruck) INTO wert;
        EXCEPTION WHEN OTHERS THEN
          -- Lässt sich der Standardwert nicht auswerten, ist das ein Befund an der Spalte statt eines Abbruchs der ganzen
          -- Prüfung (#1716). Ohne Vergleichswert bleibt die Spalte ungeprüft, sonst meldete jedes ältere Siegel sie als
          -- geändert; den geänderten Standardwert meldet daneben der Vergleich mit dem Sollbestand.
          RETURN QUERY SELECT 'sperre'::text, teil, NULL::text, NULL::bigint,
            format('Standardwert von %s.%s lässt sich nicht auswerten: %s', teil, spalte, SQLERRM);
          unauswertbar := unauswertbar || spalte;
          CONTINUE;
        END;
        IF wert IS NOT NULL THEN
          standard := standard || jsonb_build_object(spalte, wert);
        END IF;
      END LOOP;
      fehlend := array(SELECT c FROM unnest(fehlend) c WHERE c <> ALL (unauswertbar));
      CONTINUE WHEN cardinality(fehlend) = 0;
      SELECT string_agg(format('(%L, to_jsonb(t.%I))', c, c), ', ') INTO werte FROM unnest(fehlend) c;
      RETURN QUERY EXECUTE format($q$
        SELECT 'siegel'::text, %1$L::text, x.row_id::text, NULL::bigint,
               format('Spalte %%s.%%s geändert, die das Siegel nicht abdeckt', %2$L, x.spalte)
          FROM (SELECT DISTINCT s.id, s.row_id, w.spalte
                  FROM seals s
                  JOIN %2$I t ON t.%3$I = s.row_id
                 CROSS JOIN LATERAL (VALUES %4$s) w(spalte, wert)
                 WHERE s.table_name = %1$L AND s.columns <> $2 AND s.columns ? %2$L
                   AND NOT (s.columns -> %2$L) ? w.spalte
                   AND w.wert IS DISTINCT FROM ($3 -> w.spalte)) x
         ORDER BY x.id, x.spalte
         LIMIT $1
      $q$, tbl, teil, fk, werte) USING max_rows, heute, standard;
    END LOOP;
  END LOOP;

  RETURN QUERY SELECT * FROM haben_append_only_problems(max_rows);

  -- Jedes Siegel aus der Kette gibt es noch: Wer einen festgeschriebenen Datensatz samt Siegel löscht, hinterlässt keine
  -- Zeile, von der die Prüfungen oben ausgehen. Der Eintrag des Siegels im Audit-Log bleibt aber stehen; ihn zu löschen reißt
  -- eine Lücke in die Kette. Höchstens max_rows je Tabelle wie oben: integrity.ts meldet „oder mehr“ je Art und Tabelle.
  RETURN QUERY
  SELECT 'siegel'::text, x.siegel_tabelle, x.siegel_zeile, x.eintrag, 'Siegel fehlt, steht aber im Audit-Log'::text
    FROM (SELECT a.new_value ->> 'table_name' AS siegel_tabelle, a.new_value ->> 'row_id' AS siegel_zeile, a.seq AS eintrag,
                 row_number() OVER (PARTITION BY a.new_value ->> 'table_name' ORDER BY a.seq) AS nr
            FROM audit_log a
           WHERE a.table_name = 'seals' AND a.action = 'INSERT'
             AND NOT EXISTS (SELECT 1 FROM seals s WHERE s.id::text = a.row_id)) x
   WHERE x.nr <= max_rows
   ORDER BY x.eintrag;

  -- Ein Siegel gilt nur so, wie es in der Kette steht. Höchstens max_rows je Tabelle wie oben (bis 0310 über alle zusammen).
  RETURN QUERY
  SELECT 'siegel'::text, x.siegel_tabelle, x.siegel_zeile, x.eintrag, x.meldung
    FROM (SELECT s.id AS siegel, s.table_name AS siegel_tabelle, s.row_id::text AS siegel_zeile, a.seq AS eintrag,
                 CASE WHEN a.id IS NULL THEN 'Siegel fehlt im Audit-Log' ELSE 'Siegel weicht vom Eintrag im Audit-Log ab' END AS meldung,
                 row_number() OVER (PARTITION BY s.table_name ORDER BY s.id) AS nr
            FROM seals s
            LEFT JOIN audit_log a ON a.table_name = 'seals' AND a.row_id = s.id::text AND a.action = 'INSERT'
           WHERE a.id IS NULL
              OR a.new_value ->> 'digest' IS DISTINCT FROM s.digest
              OR a.new_value -> 'columns' IS DISTINCT FROM s.columns
              OR a.new_value ->> 'row_id' IS DISTINCT FROM s.row_id::text
              OR a.new_value ->> 'table_name' IS DISTINCT FROM s.table_name) x
   WHERE x.nr <= max_rows
   ORDER BY x.siegel;
END;
$$;
