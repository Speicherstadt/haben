-- PDF und XML nur anhängbarer Tabellen gegen das Audit-Log prüfen (#2038). haben_audit lässt diese Spalten weg (0304), der
-- Abgleich aus 0339 prüfte sie deshalb nicht: Mit abgeschalteten Triggern ließ sich etwa das Protokoll einer gesendeten
-- Voranmeldung, die Antwort von ELSTER oder eine verschickte Mahnung still austauschen.
--
-- 1. haben_audit_omitted_sha256 bildet den SHA-256 jeder weggelassenen Spalte einer Zeile, bei bytea den der Datei selbst.
-- 2. haben_audit schreibt ihn bei den nur anhängbaren Tabellen unter omitted_sha256 in den Eintrag; die Liste der Spalten
--    kommt jetzt aus haben_audit_omitted_columns statt aus einer eigenen Kopie.
-- 3. Zeilen von vor dieser Migration bekommen einen nachträglichen Eintrag mit ihren Hashes und die Kette einen Hinweis wie
--    in 0339.
-- 4. haben_append_only_problems vergleicht die Hashes mit den Spalten, nur aus Einträgen nach dem Stichtag in
--    audit_hash_since (Tabelle aus 0353): Vorher kann ein Eintrag mit Hashes nur angehängt sein. Der Stichtag gilt als belegt,
--    wenn genau ein Eintrag im Audit-Log ihn nennt und nach ihm liegt; sonst ist das ein eigener Befund.
--
-- Quelle: GoBD, BMF-Schreiben vom 28.11.2019, Rz. 108 (keine Änderung ohne Kenntlichmachung), am Original gelesen in #861.
--
-- An bestehenden Zeilen, Einträgen und Siegeln ändert die Migration nichts.
SELECT set_config('haben.actor', 'system:migration', true);
--> statement-breakpoint
-- Hashes der Spalten, die haben_audit weglässt, als {"omitted_sha256": {spalte: hex oder null}}, ohne solche Spalten {}.
-- to_jsonb schreibt bytea nach bytea_output; die Funktion legt hex fest und dekodiert, damit der Hash der Datei entsteht und
-- nicht von der Einstellung der Sitzung abhängt.
CREATE FUNCTION haben_audit_omitted_sha256(rec anyelement) RETURNS jsonb
LANGUAGE sql STABLE
SET bytea_output = 'hex'
AS $$
  SELECT CASE WHEN count(*) = 0 THEN '{}'::jsonb ELSE jsonb_build_object('omitted_sha256', jsonb_object_agg(a.attname,
           CASE
             WHEN x.j ->> a.attname IS NULL THEN NULL
             WHEN a.atttypid = 'bytea'::regtype THEN encode(sha256(decode(substr(x.j ->> a.attname, 3), 'hex')), 'hex')
             ELSE encode(sha256(convert_to(x.j ->> a.attname, 'UTF8')), 'hex')
           END)) END
    FROM (SELECT to_jsonb(rec) AS j) x
    JOIN pg_type ty ON ty.oid = pg_typeof(rec)
    JOIN pg_attribute a ON a.attrelid = ty.typrelid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE a.attname = ANY (haben_audit_omitted_columns())
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION haben_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_json jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  new_json jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  omit text[] := haben_audit_omitted_columns();
  -- Nur anhängbare Tabellen gleicht haben_append_only_problems mit dem Audit-Log ab; ihre PDF und XML über den Hash (#2038).
  -- Tabellen ohne solche Spalten rufen die Funktion gar nicht erst auf.
  mit_hash boolean := TG_TABLE_NAME = ANY (haben_audited_append_only_tables()) AND coalesce(new_json, old_json) ?| omit;
BEGIN
  old_json := old_json - omit;
  new_json := new_json - omit;
  IF mit_hash THEN
    IF TG_OP <> 'INSERT' THEN old_json := old_json || haben_audit_omitted_sha256(OLD); END IF;
    IF TG_OP <> 'DELETE' THEN new_json := new_json || haben_audit_omitted_sha256(NEW); END IF;
  END IF;
  INSERT INTO audit_log (actor, table_name, row_id, action, old_value, new_value)
  VALUES (
    nullif(current_setting('haben.actor', true), ''),
    TG_TABLE_NAME,
    coalesce(
      new_json ->> 'id', old_json ->> 'id',
      (new_json ->> 'year') || coalesce(':' || (new_json ->> 'contact_id'), ''),
      (old_json ->> 'year') || coalesce(':' || (old_json ->> 'contact_id'), '')
    ),
    TG_OP,
    old_json,
    new_json
  );
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- Stichtag der Hashes: der Kopf der Kette vor dem Nachtrag. Ein Eintrag mit omitted_sha256 davor kann nur angehängt sein,
-- denn haben_audit schreibt erst ab hier Hashes; der Abgleich zählt ihn nicht. Vor dem Update gibt es die Tabelle nicht,
-- niemand kann sie vorab füllen. Sie ist nur anhängbar und steht im Audit-Log, ein späteres Verschieben fällt im Abgleich
-- auf (haben_audited_append_only_tables).
CREATE TRIGGER audit_hash_since_append_only BEFORE UPDATE OR DELETE ON audit_hash_since
  FOR EACH ROW EXECUTE FUNCTION haben_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_hash_since_no_truncate BEFORE TRUNCATE ON audit_hash_since
  FOR EACH STATEMENT EXECUTE FUNCTION haben_reject_truncate();
--> statement-breakpoint
CREATE TRIGGER audit_hash_since_audit AFTER INSERT ON audit_hash_since
  FOR EACH ROW EXECUTE FUNCTION haben_audit();
--> statement-breakpoint
-- Liste wie in 0339, dazu audit_hash_since
CREATE OR REPLACE FUNCTION haben_audited_append_only_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['annual_submission_figures', 'annual_submissions', 'app_versions', 'archive_files', 'audit_hash_since', 'bank_duplicate_check',
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
-- Erst die Sperre der Kette, dann der Stichtag: So sieht max(seq) auch den Eintrag einer Sitzung, die beim Update noch
-- offen war; ihr Eintrag liegt dann vor dem Stichtag statt dahinter (READ COMMITTED: neuer Schnappschuss je Anweisung).
SELECT pg_advisory_xact_lock(hashtext('haben.audit_chain'));
--> statement-breakpoint
INSERT INTO audit_hash_since (id, seq) SELECT 1, coalesce(max(seq), 0) FROM audit_log;
--> statement-breakpoint
-- Bestand: jede Zeile mit weggelassenen Spalten, die einen INSERT-Eintrag hat, nachträglich eintragen, wie haben_audit es
-- beim Einfügen getan hätte, in der Reihenfolge des Primärschlüssels. Auch wenn schon ein Eintrag omitted_sha256 trägt: Vor
-- dieser Migration schreibt haben_audit keine Hashes, ein solcher Eintrag ist angehängt. Der Abgleich der übrigen Spalten
-- bleibt beim ersten Eintrag der Zeile. Eine Zeile ganz ohne Eintrag bleibt ein Befund („Zeile steht nicht im
-- Audit-Log“); trüge die Migration sie ein, bezeugte sie eine an den Triggern vorbei eingefügte Zeile.
DO $$
DECLARE
  tbl text;
  pk_match text;
  pk_order text;
  anzahl bigint;
  je_tabelle jsonb := '{}'::jsonb;
BEGIN
  FOREACH tbl IN ARRAY haben_audited_append_only_tables() LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_attribute a
                               WHERE a.attrelid = tbl::regclass AND a.attnum > 0 AND NOT a.attisdropped
                                 AND a.attname = ANY (haben_audit_omitted_columns()));
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
        FROM (SELECT (to_jsonb(t) - haben_audit_omitted_columns()) || haben_audit_omitted_sha256(t) AS j
                FROM %1$I t
               WHERE EXISTS (SELECT 1 FROM audit_log a
                             CROSS JOIN LATERAL jsonb_populate_record(NULL::%1$I, a.new_value) p
                              WHERE a.table_name = %1$L AND a.action = 'INSERT' AND %2$s)
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
      'hinweis', 'Hashes von PDF und XML aus nur anhängbaren Tabellen nachträglich eingetragen. '
                 'Sie bezeugen den Stand ab diesem Zeitpunkt, nicht davor.',
      'tabellen', je_tabelle));
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION haben_append_only_problems(max_rows integer DEFAULT 100)
RETURNS TABLE (art text, tabelle text, zeile text, seq bigint, befund text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  tbl text;
  pk_match text;
  pk_key text;
  zeile_t text;
  zeile_l text;
  abweichung text;
  mit_hash boolean;
  stichtag bigint;
BEGIN
  -- Stichtag der Hashes (#2038): belegt nur durch genau einen Eintrag im Audit-Log, den der Migration, der ihn nennt und
  -- nach ihm liegt. Ein vor dem Update angehängter Eintrag für audit_hash_since, ein später angehängter oder eine still
  -- entfernte Zeile bleibt so sichtbar, auch wenn danach jemand den Stichtag absenkt.
  IF to_regclass('audit_hash_since') IS NOT NULL THEN
    EXECUTE 'SELECT seq FROM audit_hash_since WHERE id = 1' INTO stichtag;
    IF stichtag IS NULL OR NOT coalesce((
         SELECT count(*) = 1 AND bool_and(a.action = 'INSERT' AND a.seq > stichtag AND a.new_value ->> 'seq' = stichtag::text)
           FROM audit_log a WHERE a.table_name = 'audit_hash_since'), false) THEN
      RETURN QUERY SELECT 'siegel'::text, 'audit_hash_since'::text, '1'::text, NULL::bigint,
        'Stichtag der Hashes von PDF und XML nicht belegt'::text;
    END IF;
  END IF;
  -- Nur anhängbare Tabellen ohne Siegel (#861): Jede Zeile steht so im Audit-Log, wie sie in der Tabelle steht. Ihr
  -- Audit-Trigger schreibt beim Einfügen den ganzen Wert, und ändern oder löschen lässt haben_append_only sie nur mit
  -- abgeschalteten Triggern; das hinterlässt keinen Eintrag. Maßgeblich ist der erste INSERT-Eintrag je Primärschlüssel:
  -- Einen weiteren Eintrag, etwa ein DELETE oder ein INSERT mit dem geänderten Wert, kann jeder mit eingeschalteten
  -- Triggern anhängen, ohne die Kette zu brechen.
  -- jsonb_populate_record wandelt den Wert in den Zeilentyp, damit etwa Zeitpunkte unabhängig von der Zeitzone der
  -- schreibenden Sitzung verglichen werden. Spalten, die eine spätere Migration ergänzt hat, fehlen in älteren Einträgen
  -- und bleiben dort ungeprüft. Die Spalten, die haben_audit weglässt (PDF, XML), vergleicht er über ihren SHA-256 (0354).
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
    SELECT EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = to_regclass(tbl) AND a.attnum > 0 AND NOT a.attisdropped
                      AND a.attname = ANY (haben_audit_omitted_columns()))
      INTO mit_hash;
    BEGIN
      RETURN QUERY EXECUTE format($q$
        WITH e AS (
          SELECT a.seq, a.new_value AS v, jsonb_populate_record(NULL::%1$I, a.new_value) AS p
            FROM audit_log a
           WHERE a.table_name = %1$L AND a.action = 'INSERT'
        ), l AS (
          SELECT DISTINCT ON (%3$s) e.* FROM e ORDER BY %3$s, e.seq
        )
        SELECT 'siegel'::text, %1$L::text, x.zeile, x.eintrag, x.befund
          FROM (SELECT CASE WHEN t._haben_da THEN %4$s ELSE %5$s END AS zeile,
                       l.seq AS eintrag,
                       CASE
                         WHEN t._haben_da IS NULL THEN 'Zeile fehlt, steht aber im Audit-Log'
                         WHEN l.seq IS NULL THEN 'Zeile steht nicht im Audit-Log'
                         ELSE 'Zeile weicht vom Audit-Log ab'
                       END AS befund
                  FROM l
                  FULL JOIN (SELECT true AS _haben_da, * FROM %1$I) t ON %2$s
                 WHERE t._haben_da IS NULL OR l.seq IS NULL OR (%6$s)) x
         ORDER BY x.eintrag NULLS LAST, x.zeile
         LIMIT $1
      $q$, tbl, pk_match, pk_key, zeile_t, zeile_l, abweichung) USING max_rows;
      -- PDF und XML (#2038): maßgeblich ist je Spalte der erste INSERT-Eintrag nach dem Stichtag (audit_hash_since), der
      -- ihren Hash nennt, bei Zeilen von vor 0354 der Nachtrag der Migration. Ein angehängter Eintrag ohne diese Spalte, etwa
      -- mit leerem omitted_sha256, ersetzt ihn nicht; einer vor dem Stichtag zählt gar nicht. Fehlt die Zeile des Stichtags,
      -- zählen alle Einträge; das ist oben schon ein Befund. Ist omitted_sha256 kein Objekt, bricht jsonb_each ab und die
      -- Tabelle meldet unten, dass der Abgleich nicht möglich ist.
      IF mit_hash THEN
        RETURN QUERY EXECUTE format($q$
          WITH e AS (
            SELECT a.seq, s.spalte, s.soll, jsonb_populate_record(NULL::%1$I, a.new_value) AS p
              FROM audit_log a
             CROSS JOIN LATERAL jsonb_each(a.new_value -> 'omitted_sha256') s(spalte, soll)
             WHERE a.table_name = %1$L AND a.action = 'INSERT' AND a.new_value ? 'omitted_sha256'
               AND a.seq > $2
          ), l AS (
            SELECT DISTINCT ON (%3$s, e.spalte) e.* FROM e ORDER BY %3$s, e.spalte, e.seq
          ), t AS (
            SELECT z.*, haben_audit_omitted_sha256(z) -> 'omitted_sha256' AS _haben_ist FROM %1$I z
          )
          SELECT 'siegel'::text, %1$L::text, %4$s, min(l.seq),
                 format('Spalte %%s weicht vom Audit-Log ab', string_agg(l.spalte, ', ' ORDER BY l.spalte))
            FROM l
            JOIN t ON %2$s
           WHERE l.soll IS DISTINCT FROM t._haben_ist -> l.spalte
           GROUP BY %4$s
           ORDER BY min(l.seq)
           LIMIT $1
        $q$, tbl, pk_match, pk_key, zeile_t) USING max_rows, coalesce(stichtag, 0);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Etwa ein älterer Wert, der sich nicht mehr in den heutigen Spaltentyp wandeln lässt: ein Befund an der Tabelle statt
      -- eines Abbruchs der ganzen Prüfung, wie bei den Standardwerten (#1716)
      RETURN QUERY SELECT 'siegel'::text, tbl, NULL::text, NULL::bigint,
        format('Abgleich mit dem Audit-Log nicht möglich: %s', SQLERRM);
    END;
  END LOOP;
END;
$$;
