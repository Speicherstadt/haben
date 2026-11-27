-- Nur anhängbare Tabellen ohne Siegel gegen das Audit-Log prüfen (#861). Mit abgeschalteten Triggern ließ sich eine Zeile in
-- einer solchen Tabelle (etwa invoice_settlements) ändern oder löschen, ohne dass haben_integrity_problems etwas meldete:
-- Die Prüfung verglich Einträge im Audit-Log nur für seals mit den vorhandenen Zeilen (0311).
--
-- 1. Audit-Trigger für die fünf nur anhängbaren Tabellen, die keinen hatten; Bankumsätze stehen damit im Audit-Log.
-- 2. Zeilen dieser Tabellen ohne Eintrag im Audit-Log trägt die Migration nachträglich ein, mit einem Hinweis in der Kette
--    wie in 0063. Auf einer frischen Installation gibt es keine.
-- 3. haben_integrity_problems wie in 0318, dazu der Abgleich jeder dieser Tabellen mit ihren Einträgen im Audit-Log.
--
-- An bestehenden Zeilen, Einträgen und Siegeln ändert die Migration nichts.
SELECT set_config('haben.actor', 'system:migration', true);
--> statement-breakpoint
CREATE TRIGGER bank_transactions_audit AFTER INSERT ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION haben_audit();
--> statement-breakpoint
CREATE TRIGGER contact_versions_audit AFTER INSERT ON contact_versions
  FOR EACH ROW EXECUTE FUNCTION haben_audit();
--> statement-breakpoint
CREATE TRIGGER datev_bookings_audit AFTER INSERT ON datev_bookings
  FOR EACH ROW EXECUTE FUNCTION haben_audit();
--> statement-breakpoint
CREATE TRIGGER lexoffice_vouchers_audit AFTER INSERT ON lexoffice_vouchers
  FOR EACH ROW EXECUTE FUNCTION haben_audit();
--> statement-breakpoint
CREATE TRIGGER lexoffice_voucher_files_audit AFTER INSERT ON lexoffice_voucher_files
  FOR EACH ROW EXECUTE FUNCTION haben_audit();
--> statement-breakpoint
-- Tabellen, die haben_integrity_problems mit dem Audit-Log abgleicht: jede mit haben_append_only vor UPDATE und DELETE und
-- einem Audit-Trigger beim Einfügen, ohne Siegel. Versiegelte Tabellen und ihre Kindtabellen (vat_return_filings) prüft das
-- Siegel. Eine neue nur anhängbare Tabelle kommt hierher oder bekommt ein Siegel; integrity-anhaengbar.test.ts prüft das
-- am Katalog.
CREATE FUNCTION haben_audited_append_only_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['annual_submission_figures', 'annual_submissions', 'app_versions', 'archive_files', 'bank_duplicate_check',
    'bank_duplicate_decisions', 'bank_duplicate_reviews', 'bank_import_transactions', 'bank_imports', 'bank_neutralizations',
    'bank_transactions', 'brm_requests', 'contact_versions', 'datev_bookings', 'datev_personenkonten', 'dividends',
    'document_iban_decisions', 'document_settlements', 'dunnings', 'elster_messages', 'external_import_settlements',
    'external_imports', 'import_batches', 'import_conflicts', 'import_movements', 'import_resolutions', 'import_sources',
    'inbox_messages', 'invoice_settlements', 'journal_umstellung', 'kapest_submissions', 'legacy_dunning_files',
    'legacy_dunnings', 'legacy_file_states', 'legacy_order_documents', 'legacy_order_files', 'legacy_order_pdf_attempts',
    'legacy_vat_report_files', 'legacy_vat_reports', 'legacy_voucher_payments', 'lexoffice_voucher_files',
    'lexoffice_vouchers', 'local_owner_recoveries', 'lsta_submissions', 'lstb_submissions', 'mail_log', 'password_changes',
    'postfach_documents', 'postfach_erledigt', 'postfach_requests', 'sepa_direct_debit_items', 'sepa_direct_debits',
    'sepa_mandate_files', 'sepa_mandate_revocations', 'sepa_mandates', 'sepa_transfer_items', 'sepa_transfers',
    'sevdesk_accounting_type_decisions', 'sevdesk_accounting_types', 'sevdesk_tax_sets', 'sso_issuers', 'sso_takeovers',
    'store_payouts', 'store_reports', 'sv_portal_filings', 'token_events', 'user_logins', 'ustid_bestaetigungen',
    'vast_belege', 'vast_requests', 'vat_extension_submissions', 'vat_items_since', 'vat_return_submissions', 'write_offs',
    'year_closings', 'zm_submissions']
$$;
--> statement-breakpoint
-- Spalten, die haben_audit nicht ins Audit-Log schreibt (Liste wie dort, 0304); der Abgleich lässt sie aus.
CREATE FUNCTION haben_audit_omitted_columns() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['ciphertext', 'pin_ciphertext', 'protocol_pdf', 'pdf', 'xml', 'logo', 'background', 'request_xml',
               'response_xml', 'server_response_xml', 'abholung']
$$;
--> statement-breakpoint
-- Bestand: jede Zeile ohne Eintrag im Audit-Log nachträglich eintragen, wie haben_audit es beim Einfügen getan hätte, in der
-- Reihenfolge des Primärschlüssels. Betrifft die fünf Tabellen oben und Zeilen, die vor dem Audit-Trigger ihrer Tabelle
-- entstanden. Ein Eintrag gilt als vorhanden, wenn sein Wert den Primärschlüssel der Zeile trägt, egal mit welcher row_id.
DO $$
DECLARE
  tbl text;
  pk_match text;
  pk_order text;
  anzahl bigint;
  je_tabelle jsonb := '{}'::jsonb;
BEGIN
  FOREACH tbl IN ARRAY haben_audited_append_only_tables() LOOP
    SELECT string_agg(format('p.%1$I = t.%1$I', a.attname), ' AND ' ORDER BY k.nr),
           string_agg(format('t.%I', a.attname), ', ' ORDER BY k.nr)
      INTO pk_match, pk_order
      FROM pg_index i
     CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, nr)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE i.indrelid = tbl::regclass AND i.indisprimary;
    EXECUTE format($q$
      INSERT INTO audit_log (actor, table_name, row_id, action, old_value, new_value)
      SELECT 'system:migration', %1$L,
             coalesce(x.j ->> 'id', (x.j ->> 'year') || coalesce(':' || (x.j ->> 'contact_id'), '')), 'INSERT', NULL, x.j
        FROM (SELECT to_jsonb(t) - haben_audit_omitted_columns() AS j
                FROM %1$I t
               WHERE NOT EXISTS (SELECT 1 FROM audit_log a
                                 CROSS JOIN LATERAL jsonb_populate_record(NULL::%1$I, coalesce(a.new_value, a.old_value)) p
                                  WHERE a.table_name = %1$L AND %2$s)
               ORDER BY %3$s) x
    $q$, tbl, pk_match, pk_order);
    GET DIAGNOSTICS anzahl = ROW_COUNT;
    IF anzahl > 0 THEN
      je_tabelle := je_tabelle || jsonb_build_object(tbl, anzahl);
    END IF;
  END LOOP;
  IF je_tabelle <> '{}'::jsonb THEN
    INSERT INTO audit_log (actor, table_name, row_id, action, old_value, new_value)
    VALUES ('system:migration', 'audit_chain', '1', 'INSERT', NULL, jsonb_build_object(
      'hinweis', 'Zeilen aus nur anhängbaren Tabellen, die noch nicht im Audit-Log standen, nachträglich eingetragen. '
                 'Die Einträge bezeugen den Stand ab diesem Zeitpunkt, nicht davor.',
      'tabellen', je_tabelle));
  END IF;
END;
$$;
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
  pk_match text;
  pk_key text;
  zeile_t text;
  zeile_l text;
  abweichung text;
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
                             'payslips', 'payslip_cancellations'] LOOP
    locked := CASE WHEN tbl IN ('cash_entries', 'allocations', 'pauschalen', 'asset_depreciations', 'document_cancellations',
                                'payslip_cancellations') THEN 'true'
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

  -- Nur anhängbare Tabellen ohne Siegel (#861): Jede Zeile steht so im Audit-Log, wie sie in der Tabelle steht. Ihr
  -- Audit-Trigger schreibt beim Einfügen den ganzen Wert, und ändern oder löschen lässt haben_append_only sie nur mit
  -- abgeschalteten Triggern; das hinterlässt keinen Eintrag. Maßgeblich ist der letzte Eintrag je Primärschlüssel.
  -- jsonb_populate_record wandelt den Wert in den Zeilentyp, damit etwa Zeitpunkte unabhängig von der Zeitzone der
  -- schreibenden Sitzung verglichen werden. Spalten, die eine spätere Migration ergänzt hat, fehlen in älteren Einträgen
  -- und bleiben dort ungeprüft; die Spalten, die haben_audit weglässt (PDF, XML), prüft der Abgleich nicht.
  FOREACH tbl IN ARRAY haben_audited_append_only_tables() LOOP
    IF to_regclass(tbl) IS NULL THEN
      RETURN QUERY SELECT 'siegel'::text, tbl, NULL::text, NULL::bigint, 'Tabelle fehlt'::text;
      CONTINUE;
    END IF;
    SELECT string_agg(format('(l.p).%1$I = t.%1$I', a.attname), ' AND ' ORDER BY k.nr),
           string_agg(format('(e.p).%I', a.attname), ', ' ORDER BY k.nr),
           format('concat_ws(%L, %s)', ':', string_agg(format('t.%I', a.attname), ', ' ORDER BY k.nr)),
           format('concat_ws(%L, %s)', ':', string_agg(format('(l.p).%I', a.attname), ', ' ORDER BY k.nr))
      INTO pk_match, pk_key, zeile_t, zeile_l
      FROM pg_index i
     CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, nr)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE i.indrelid = to_regclass(tbl) AND i.indisprimary;
    IF pk_match IS NULL THEN
      RETURN QUERY SELECT 'siegel'::text, tbl, NULL::text, NULL::bigint, 'Ohne Primärschlüssel kein Abgleich mit dem Audit-Log'::text;
      CONTINUE;
    END IF;
    SELECT coalesce(string_agg(format('(l.v ? %1$L AND (l.p).%1$I IS DISTINCT FROM t.%1$I)', a.attname), ' OR ' ORDER BY a.attnum), 'false')
      INTO abweichung
      FROM pg_attribute a
     WHERE a.attrelid = to_regclass(tbl) AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname <> ALL (haben_audit_omitted_columns());
    BEGIN
      RETURN QUERY EXECUTE format($q$
        WITH e AS (
          SELECT a.seq, a.action, coalesce(a.new_value, a.old_value) AS v,
                 jsonb_populate_record(NULL::%1$I, coalesce(a.new_value, a.old_value)) AS p
            FROM audit_log a
           WHERE a.table_name = %1$L
        ), l AS (
          SELECT DISTINCT ON (%3$s) e.* FROM e ORDER BY %3$s, e.seq DESC
        )
        SELECT 'siegel'::text, %1$L::text, x.zeile, x.eintrag, x.befund
          FROM (SELECT CASE WHEN t._haben_da THEN %4$s ELSE %5$s END AS zeile,
                       CASE WHEN l.action <> 'DELETE' THEN l.seq END AS eintrag,
                       CASE
                         WHEN t._haben_da IS NULL THEN 'Zeile fehlt, steht aber im Audit-Log'
                         WHEN l.seq IS NULL OR l.action = 'DELETE' THEN 'Zeile steht nicht im Audit-Log'
                         ELSE 'Zeile weicht vom Audit-Log ab'
                       END AS befund
                  FROM l
                  FULL JOIN (SELECT true AS _haben_da, * FROM %1$I) t ON %2$s
                 WHERE (t._haben_da IS NULL AND l.action <> 'DELETE')
                    OR (t._haben_da AND (l.seq IS NULL OR l.action = 'DELETE'))
                    OR (t._haben_da AND l.action <> 'DELETE' AND (%6$s))) x
         ORDER BY x.eintrag NULLS LAST, x.zeile
         LIMIT $1
      $q$, tbl, pk_match, pk_key, zeile_t, zeile_l, abweichung) USING max_rows;
    EXCEPTION WHEN OTHERS THEN
      -- Etwa ein älterer Wert, der sich nicht mehr in den heutigen Spaltentyp wandeln lässt: ein Befund an der Tabelle statt
      -- eines Abbruchs der ganzen Prüfung, wie bei den Standardwerten (#1716)
      RETURN QUERY SELECT 'siegel'::text, tbl, NULL::text, NULL::bigint,
        format('Abgleich mit dem Audit-Log nicht möglich: %s', SQLERRM);
    END;
  END LOOP;

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
