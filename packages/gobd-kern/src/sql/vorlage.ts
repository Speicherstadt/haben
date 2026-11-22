/*
 * SQL-Vorlage für Hash-Kette, Siegel und Sperren in Postgres, nach dem Vorbild von Haben (drizzle/0001, 0062, 0063,
 * 0201 dort). Ein neues Projekt übernimmt sie einmal in seine erste Migration; danach gehört das SQL dem Projekt, eine
 * Änderung wird eine neue Migration. Die Unveränderbarkeit hängt so an Triggern in der Datenbank, nicht am App-Code.
 *
 * Unterschiede zu Haben: Tabellen werden nicht im SQL aufgezählt, sondern mit <präfix>_audit_table und
 * <präfix>_seal_table angemeldet; ein Siegel gilt einer Zeile (abhängige Zeilen bekommen ihr eigenes Siegel); eine
 * leere Kette ist gültig. Gleich sind Hash, Kopf der Kette, Sperren und Prüfung.
 */

import { pruefung } from "./pruefung.ts";

export interface VorlageOptionen {
  /** Präfix für Funktionen, die Einstellung des Akteurs (<präfix>.actor) und die Sperre der Kette, etwa „belegt“ */
  praefix: string;
}

/** Trennzeichen zwischen Anweisungen, wie drizzle-kit es in Migrationen erwartet */
export const ANWEISUNGSGRENZE = "--> statement-breakpoint";

/** Name der Einstellung, in der eine Transaktion ihren Akteur für das Audit-Log setzt (set_config(…, true)) */
export function akteurEinstellung(praefix: string): string {
  pruefePraefix(praefix);
  return `${praefix}.actor`;
}

function pruefePraefix(praefix: string): void {
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(praefix)) {
    throw new Error(`Ungültiges Präfix „${praefix}“: Kleinbuchstaben, Ziffern und _, höchstens 31 Zeichen`);
  }
}

/** Die Vorlage als Anweisungen, getrennt mit ANWEISUNGSGRENZE */
export function vorlageSql({ praefix: p }: VorlageOptionen): string {
  pruefePraefix(p);
  return anweisungen(p).join(`\n${ANWEISUNGSGRENZE}\n`);
}

function anweisungen(p: string): string[] {
  return [
    // Tabellen ------------------------------------------------------------------------------------------------
    `CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamp with time zone NOT NULL DEFAULT now(),
  actor text,
  table_name text NOT NULL,
  row_id text,
  action text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  seq bigint NOT NULL,
  prev_hash bytea NOT NULL,
  row_hash bytea NOT NULL
)`,
    "CREATE UNIQUE INDEX audit_log_seq ON audit_log (seq)",
    `CREATE TABLE audit_chain (
  id smallint PRIMARY KEY DEFAULT 1,
  seq bigint NOT NULL,
  hash bytea NOT NULL,
  CONSTRAINT audit_chain_single_row CHECK (id = 1)
)`,
    `CREATE TABLE seals (
  id bigserial PRIMARY KEY,
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  columns jsonb NOT NULL,
  digest text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
)`,
    "CREATE UNIQUE INDEX seals_row ON seals (table_name, row_id)",
    // Angemeldete versiegelte Tabellen; locked_column NULL heißt: jede Zeile ist ab dem Einfügen fest
    `CREATE TABLE sealed_tables (
  table_name text PRIMARY KEY,
  locked_column text
)`,
    // Sperren -------------------------------------------------------------------------------------------------
    `CREATE FUNCTION ${p}_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% darf nur ergänzt werden', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$`,
    // Zeilen-Trigger feuern bei TRUNCATE nicht; ohne diese Sperre leerte TRUNCATE (auch per CASCADE) geschützte Tabellen
    `CREATE FUNCTION ${p}_reject_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% darf nicht geleert werden: TRUNCATE umgeht die Sperre der Zeilen und das Audit-Log', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$`,
    // Festgeschriebene Zeilen: die Spalte steht im ersten Argument des Triggers
    `CREATE FUNCTION ${p}_reject_locked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(OLD) ->> TG_ARGV[0] IS NOT NULL THEN
    RAISE EXCEPTION '% % ist festgeschrieben und kann nicht geändert werden', TG_TABLE_NAME, to_jsonb(OLD) ->> 'id'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$`,
    // Audit-Log -----------------------------------------------------------------------------------------------
    // Spalten in den Argumenten des Triggers (etwa ciphertext) kommen nicht ins Protokoll
    `CREATE FUNCTION ${p}_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_json jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  new_json jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
BEGIN
  IF TG_NARGS > 0 THEN
    old_json := old_json - TG_ARGV;
    new_json := new_json - TG_ARGV;
  END IF;
  INSERT INTO audit_log (actor, table_name, row_id, action, old_value, new_value)
  VALUES (
    nullif(current_setting('${p}.actor', true), ''),
    TG_TABLE_NAME,
    coalesce(new_json ->> 'id', old_json ->> 'id'),
    TG_OP,
    old_json,
    new_json
  );
  RETURN NULL;
END;
$$`,
    // Hash eines Eintrags: SHA-256(Vorgänger || Inhalt); jsonb hat eine feste Textform, der Zeitpunkt steht in UTC
    `CREATE FUNCTION ${p}_audit_hash(prev bytea, r audit_log) RETURNS bytea
LANGUAGE sql STABLE AS $$
  SELECT sha256(prev || convert_to(jsonb_build_array(
    r.seq,
    to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    r.actor,
    r.table_name,
    r.row_id,
    r.action,
    r.old_value,
    r.new_value
  )::text, 'UTF8'))
$$`,
    `CREATE FUNCTION ${p}_audit_genesis() RETURNS bytea
LANGUAGE sql IMMUTABLE AS $$ SELECT decode(repeat('00', 32), 'hex') $$`,
    // Jeder Eintrag hängt sich an den letzten. Die Sperre hält bis zum Ende der Transaktion; unter REPEATABLE READ
    // oder SERIALIZABLE wäre der Vorgänger womöglich nicht sichtbar und die Kette verzweigte sich, dort wird abgelehnt.
    `CREATE FUNCTION ${p}_audit_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last audit_log;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Änderungen mit Eintrag im Audit-Log nur unter READ COMMITTED, sonst verzweigt die Hash-Kette'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('${p}.audit_chain'));
  SELECT * INTO last FROM audit_log ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(last.seq, 0) + 1;
  NEW.prev_hash := coalesce(last.row_hash, ${p}_audit_genesis());
  NEW.row_hash := ${p}_audit_hash(NEW.prev_hash, NEW);
  RETURN NEW;
END;
$$`,
    // Den Kopf erst beim Commit fortschreiben, mit dem letzten Eintrag der Transaktion
    `CREATE FUNCTION ${p}_audit_chain_head() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.seq = (SELECT max(seq) FROM audit_log) THEN
    UPDATE audit_chain SET seq = NEW.seq, hash = NEW.row_hash WHERE id = 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Der Kopf der Kette im Audit-Log fehlt' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$`,
    // Den Kopf schreibt nur der Trigger des Audit-Logs fort (Trigger-Tiefe größer als 1)
    `CREATE FUNCTION ${p}_audit_chain_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Der Kopf der Kette wird nur vom Audit-Log fortgeschrieben' USING ERRCODE = 'check_violation';
END;
$$`,
    `CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION ${p}_append_only()`,
    `CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION ${p}_audit_chain()`,
    `CREATE CONSTRAINT TRIGGER audit_log_chain_head AFTER INSERT ON audit_log
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ${p}_audit_chain_head()`,
    // Der Kopf einer leeren Kette: Nummer 0 und der Vorgänger des ersten Eintrags
    `INSERT INTO audit_chain (id, seq, hash) VALUES (1, 0, ${p}_audit_genesis())`,
    `CREATE TRIGGER audit_chain_guard BEFORE UPDATE OR DELETE ON audit_chain
  FOR EACH ROW EXECUTE FUNCTION ${p}_audit_chain_guard()`,
    `CREATE TRIGGER audit_chain_no_truncate BEFORE TRUNCATE ON audit_chain
  FOR EACH STATEMENT EXECUTE FUNCTION ${p}_append_only()`,
    ...siegel(p),
    ...anmeldung(p),
    pruefung(p),
  ];
}

function siegel(p: string): string[] {
  return [
    `CREATE FUNCTION ${p}_columns(tbl regclass) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(attname::text ORDER BY attnum), '[]'::jsonb)
    FROM pg_attribute
   WHERE attrelid = tbl AND attnum > 0 AND NOT attisdropped
$$`,
    `CREATE FUNCTION ${p}_pick(row_json jsonb, cols jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(row_json) AS e(k, v) WHERE cols ? k
$$`,
    // SHA-256 über die Zeile, beschränkt auf die Spalten des Siegels. Neue Spalten ändern bestehende Siegel nicht; eine
    // Migration, die eine dieser Spalten umbenennt, löscht oder umrechnet, schon. Die Einstellungen legen die Textform
    // von Zeitstempeln und Binärdaten fest, damit der Hash nicht von der Sitzung abhängt.
    `CREATE FUNCTION ${p}_seal_digest(tbl text, rid uuid, cols jsonb) RETURNS text
LANGUAGE plpgsql STABLE
SET TimeZone = 'UTC' SET bytea_output = 'hex' SET IntervalStyle = 'postgres' SET extra_float_digits = 1
AS $$
DECLARE
  content jsonb;
BEGIN
  EXECUTE format('SELECT jsonb_build_object(%L, ${p}_pick(to_jsonb(t), $1)) FROM %I t WHERE t.id = $2', tbl, tbl)
    INTO content USING cols -> tbl, rid;
  RETURN encode(sha256(convert_to(coalesce(content, '{}'::jsonb)::text, 'UTF8')), 'hex');
END;
$$`,
    `CREATE FUNCTION ${p}_seal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cols jsonb := jsonb_build_object(TG_TABLE_NAME, ${p}_columns(TG_RELID));
BEGIN
  INSERT INTO seals (table_name, row_id, columns, digest)
  VALUES (TG_TABLE_NAME, NEW.id, cols, ${p}_seal_digest(TG_TABLE_NAME, NEW.id, cols));
  RETURN NULL;
END;
$$`,
    `CREATE TRIGGER seals_append_only BEFORE UPDATE OR DELETE ON seals
  FOR EACH ROW EXECUTE FUNCTION ${p}_append_only()`,
    `CREATE TRIGGER seals_no_truncate BEFORE TRUNCATE ON seals
  FOR EACH STATEMENT EXECUTE FUNCTION ${p}_append_only()`,
    `CREATE TRIGGER seals_audit AFTER INSERT ON seals
  FOR EACH ROW EXECUTE FUNCTION ${p}_audit()`,
    // Wie die Liste in Haben ändert sich die Anmeldung nur per Migration (neue Tabelle), nie per UPDATE oder DELETE
    `CREATE TRIGGER sealed_tables_append_only BEFORE UPDATE OR DELETE ON sealed_tables
  FOR EACH ROW EXECUTE FUNCTION ${p}_append_only()`,
    `CREATE TRIGGER sealed_tables_audit AFTER INSERT OR UPDATE OR DELETE ON sealed_tables
  FOR EACH ROW EXECUTE FUNCTION ${p}_audit()`,
    `CREATE TRIGGER sealed_tables_no_truncate BEFORE TRUNCATE ON sealed_tables
  FOR EACH STATEMENT EXECUTE FUNCTION ${p}_reject_truncate()`,
  ];
}

function anmeldung(p: string): string[] {
  return [
    // Jede Änderung der Tabelle ins Audit-Log, TRUNCATE gesperrt; ausgelassene Spalten (etwa ciphertext) als Argumente
    `CREATE FUNCTION ${p}_audit_table(tbl regclass, VARIADIC skip text[] DEFAULT '{}') RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  name text := (SELECT relname FROM pg_class WHERE oid = tbl);
  args text := (SELECT string_agg(quote_literal(s), ', ') FROM unnest(skip) AS s);
BEGIN
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION ${p}_audit(%s)',
    name || '_audit', tbl, coalesce(args, ''));
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION ${p}_reject_truncate()',
    name || '_no_truncate', tbl);
END;
$$`,
    // Versiegelt eine Tabelle mit uuid-Spalte id. Ohne locked_column ist jede Zeile ab dem Einfügen fest; mit ihr ab dem
    // Setzen der Spalte, davor bleibt sie änderbar und löschbar (Entwurf). Audit-Log und TRUNCATE-Sperre inklusive.
    `CREATE FUNCTION ${p}_seal_table(tbl regclass, locked_column text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  name text := (SELECT relname FROM pg_class WHERE oid = tbl);
BEGIN
  PERFORM ${p}_audit_table(tbl);
  INSERT INTO sealed_tables (table_name, locked_column) VALUES (name, locked_column);
  IF locked_column IS NULL THEN
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION ${p}_append_only()',
      name || '_append_only', tbl);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON %s FOR EACH ROW EXECUTE FUNCTION ${p}_seal()', name || '_seal', tbl);
  ELSE
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION ${p}_reject_locked(%L)',
      name || '_locked', tbl, locked_column);
    EXECUTE format('CREATE TRIGGER %I AFTER UPDATE OF %I ON %s FOR EACH ROW WHEN (OLD.%I IS NULL AND NEW.%I IS NOT NULL) EXECUTE FUNCTION ${p}_seal()',
      name || '_seal', locked_column, tbl, locked_column, locked_column);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON %s FOR EACH ROW WHEN (NEW.%I IS NOT NULL) EXECUTE FUNCTION ${p}_seal()',
      name || '_seal_insert', tbl, locked_column);
  END IF;
END;
$$`,
  ];
}
