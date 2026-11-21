/*
 * Prüfung der SQL-Vorlage (vorlage.ts): <präfix>_integrity_problems meldet Befunde zu Kette, Kopf, Anmeldungen und Siegeln.
 * Vorbild ist haben_integrity_problems in Haben, zuletzt drizzle/0311 dort (Siegel, die im Audit-Log stehen, aber fehlen).
 */

export function pruefung(p: string): string {
  // Alle Befunde, je Art höchstens max_rows. art: kette (Audit-Log), kopf (Kopf der Kette), siegel
  return `CREATE FUNCTION ${p}_integrity_problems(max_rows integer DEFAULT 100)
RETURNS TABLE (art text, tabelle text, zeile text, seq bigint, befund text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  st sealed_tables;
  locked text;
BEGIN
  RETURN QUERY
  SELECT 'kette'::text, 'audit_log'::text, c.id::text, c.seq,
    CASE
      WHEN c.seq <> coalesce(c.before_seq, 0) + 1 THEN format('Lücke: auf Eintrag %s folgt %s', coalesce(c.before_seq, 0), c.seq)
      WHEN c.prev_hash IS DISTINCT FROM coalesce(c.before_hash, ${p}_audit_genesis()) THEN 'Verweis auf den Vorgänger passt nicht'
      ELSE 'Inhalt passt nicht zum Hash'
    END
  FROM (
    SELECT a.id, a.seq, a.prev_hash, a.row_hash, ${p}_audit_hash(a.prev_hash, a) AS calc,
           lag(a.seq) OVER w AS before_seq, lag(a.row_hash) OVER w AS before_hash
      FROM audit_log a
    WINDOW w AS (ORDER BY a.seq)
  ) c
  WHERE c.seq <> coalesce(c.before_seq, 0) + 1
     OR c.prev_hash IS DISTINCT FROM coalesce(c.before_hash, ${p}_audit_genesis())
     OR c.row_hash IS DISTINCT FROM c.calc
  ORDER BY c.seq
  LIMIT max_rows;

  -- Eine leere Kette hat den Kopf 0 mit dem Vorgänger des ersten Eintrags
  RETURN QUERY
  SELECT 'kopf'::text, 'audit_chain'::text, NULL::text, h.seq,
    CASE
      WHEN h.id IS NULL THEN 'Kopf der Kette fehlt'
      WHEN coalesce(last.seq, 0) IS DISTINCT FROM h.seq THEN format('Kopf steht bei %s, das Audit-Log endet bei %s', h.seq, coalesce(last.seq, 0))
      ELSE 'Kopf passt nicht zum letzten Eintrag'
    END
  FROM (SELECT 1) one
  LEFT JOIN audit_chain h ON true
  LEFT JOIN LATERAL (SELECT a.seq, a.row_hash FROM audit_log a ORDER BY a.seq DESC LIMIT 1) last ON true
  WHERE h.id IS NULL
     OR coalesce(last.seq, 0) IS DISTINCT FROM h.seq
     OR coalesce(last.row_hash, ${p}_audit_genesis()) IS DISTINCT FROM h.hash;

  -- Eine Anmeldung gilt nur so, wie sie in der Kette steht; sonst fiele eine an den Triggern vorbei entfernte Tabelle
  -- unbemerkt aus der Prüfung
  RETURN QUERY
  SELECT 'siegel'::text, coalesce(t.table_name, a.new_value ->> 'table_name'), NULL::text, a.seq,
    CASE
      WHEN t.table_name IS NULL THEN 'Angemeldete Tabelle fehlt in sealed_tables'
      WHEN a.id IS NULL THEN 'Anmeldung fehlt im Audit-Log'
      ELSE 'Anmeldung weicht vom Eintrag im Audit-Log ab'
    END
    FROM sealed_tables t
    FULL JOIN (SELECT * FROM audit_log WHERE table_name = 'sealed_tables' AND action = 'INSERT') a
      ON a.new_value ->> 'table_name' = t.table_name
   WHERE t.table_name IS NULL OR a.id IS NULL OR a.new_value ->> 'locked_column' IS DISTINCT FROM t.locked_column
   ORDER BY 2
   LIMIT max_rows;

  FOR st IN SELECT * FROM sealed_tables ORDER BY table_name LOOP
    locked := CASE WHEN st.locked_column IS NULL THEN 'true' ELSE format('t.%I IS NOT NULL', st.locked_column) END;
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
          AND (t.id IS NULL OR NOT (%2$s) OR ${p}_seal_digest(s.table_name, s.row_id, s.columns) <> s.digest)
        ORDER BY s.id
        LIMIT $1)
      UNION ALL
      (SELECT 'siegel'::text, %1$L::text, t.id::text, NULL::bigint, 'Festgeschrieben, aber ohne Siegel'
         FROM %1$I t
        WHERE %2$s
          AND NOT EXISTS (SELECT 1 FROM seals s WHERE s.table_name = %1$L AND s.row_id = t.id)
        ORDER BY t.id
        LIMIT $1)
    $q$, st.table_name, locked) USING max_rows;
  END LOOP;

  -- Jedes Siegel aus der Kette gibt es noch: Wer eine festgeschriebene Zeile samt Siegel an den Triggern vorbei löscht,
  -- hinterlässt keine Zeile, von der die Prüfungen oben ausgehen. Der Eintrag des Siegels im Audit-Log bleibt, seals ist
  -- nur anhängbar; ihn zu löschen reißt eine Lücke in die Kette.
  RETURN QUERY
  SELECT 'siegel'::text, a.new_value ->> 'table_name', a.new_value ->> 'row_id', a.seq, 'Siegel fehlt, steht aber im Audit-Log'::text
    FROM audit_log a
   WHERE a.table_name = 'seals' AND a.action = 'INSERT'
     AND NOT EXISTS (SELECT 1 FROM seals s WHERE s.id::text = a.row_id)
   ORDER BY a.seq
   LIMIT max_rows;

  -- Ein Siegel gilt nur so, wie es in der Kette steht
  RETURN QUERY
  SELECT 'siegel'::text, s.table_name, s.row_id::text, a.seq,
    CASE WHEN a.id IS NULL THEN 'Siegel fehlt im Audit-Log' ELSE 'Siegel weicht vom Eintrag im Audit-Log ab' END
    FROM seals s
    LEFT JOIN audit_log a ON a.table_name = 'seals' AND a.row_id = s.id::text AND a.action = 'INSERT'
   WHERE a.id IS NULL
      OR a.new_value ->> 'digest' IS DISTINCT FROM s.digest
      OR a.new_value -> 'columns' IS DISTINCT FROM s.columns
      OR a.new_value ->> 'row_id' IS DISTINCT FROM s.row_id::text
      OR a.new_value ->> 'table_name' IS DISTINCT FROM s.table_name
   ORDER BY s.id
   LIMIT max_rows;
END;
$$`;
}
