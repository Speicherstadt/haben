import { createHash } from "node:crypto";
import { type Eingebaute, type Erweiterungen, erweiterungsmitglieder, type Katalogobjekte, leseEingebaute, leseKatalogobjekte } from "./katalog.ts";
import type { Abfrage, Leser, SperrenOptionen } from "./verbindung.ts";

/** Standardwert einer Spalte, als Ausdruck wie von pg_get_expr ausgegeben */
export type Standardwert = { table: string; column: string; expression: string };

/**
 * Was eine frisch migrierte Datenbank an Triggern, Funktionen und Standardwerten hat. Die App liefert ihn als Datei aus und
 * vergleicht die laufende Datenbank damit; die englischen Schlüssel sind das Format dieser Datei.
 */
export interface Sollbestand {
  triggers: { table: string; name: string; enabled: string; definition: string; function: string }[];
  functions: { name: string; sourceHash: string; definitionHash: string; config: string[]; language: string; securityDefiner: boolean }[];
  /** Tabellen, deren Standardwerte zum Bestand gehören, bei Haben die versiegelten samt Kindtabellen */
  sealedTables: string[];
  /** Standardwerte ihrer Spalten; eine Spalte ohne Standardwert steht nicht darin */
  defaults: Standardwert[];
  /** Eingebaute Funktionen von PostgreSQL, die nicht fest eingebaut sind (katalog.ts) */
  builtins: Eingebaute;
  /** Mitglieder der Erweiterungen einer frischen Installation (katalog.ts) */
  extensions: Erweiterungen;
}

/** Dauerhafte Vorgabe session_replication_role = replica: für die Verbindung, die Datenbank oder eine Rolle */
export type ReplicaVorgabe =
  | { bereich: "verbindung" }
  | { bereich: "datenbank"; datenbank: string }
  | { bereich: "rolle"; rolle: string; datenbank: string | null };

/** Tabellen im geprüften Schema mit eingeschalteter oder erzwungener Zeilensicherheit und die Policies darauf */
export type Zeilensicherheit = {
  tables: { table: string; enabled: boolean; forced: boolean }[];
  policies: { table: string; name: string }[];
};

/** Alles, was der Vergleich aus einer Datenbank braucht, gelesen in einer Transaktion */
export interface Momentaufnahme {
  bestand: Sollbestand;
  replica: ReplicaVorgabe[];
  /** current_schemas(true) der prüfenden Verbindung, gelesen vor dem Umstellen des Suchpfads */
  suchpfad: string[];
  /** ihr temporäres Schema (pg_my_temp_schema), falls es eines gibt */
  temp: string | null;
  katalog: Katalogobjekte;
  zeilensicherheit: Zeilensicherheit;
}

/**
 * `tabellen` nennt die Tabellen, deren Standardwerte gelesen werden: bei der Prüfung einer Instanz die aus dem
 * Sollbestand, sonst bestimmte eine veränderte Funktion den Umfang. Eine Funktion bestimmt sie stattdessen in derselben
 * Transaktion, mit search_path = schema; das ist dem Generator auf einer frisch migrierten Datenbank vorbehalten.
 */
export type LeseOptionen = SperrenOptionen & { tabellen: string[] | ((abfrage: Abfrage) => Promise<string[]>) };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * pg_get_triggerdef enthält WHEN, UPDATE OF, Constraintaufschub und Argumente, keine instanzabhängigen OIDs.
 * Ein fester search_path macht darin auch Funktions- und Typnamen eindeutig; die Einstellung gilt nur lokal
 * und wird vor Verlassen der Transaktion zurückgesetzt. Qualifizierte Kataloge verhindern den Vorrang von pg_temp.
 * Auch die Pfadeinstellung selbst darf kein Betreiberobjekt auflösen. Keines der gelesenen Datenbankobjekte wird verändert.
 * https://www.postgresql.org/docs/18/runtime-config-client.html#GUC-SEARCH-PATH
 * https://www.postgresql.org/docs/18/catalog-pg-trigger.html
 * https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-INFO-CATALOG-TABLE
 * https://github.com/Speicherstadt/haben/issues/764#issuecomment-6837874131
 */
export async function leseMomentaufnahme(leser: Leser, optionen: LeseOptionen): Promise<Momentaufnahme> {
  const { schema, praefix } = optionen;
  return leser.transaktion(async (abfrage) => {
    // current_schemas vor dem Umstellen: der Suchpfad, mit dem die Verbindung die Prüffunktionen aufruft
    const [einstellung] = await abfrage<{ path: string; schemas: string[]; temp: string | null }>(
      `select pg_catalog.current_setting('search_path') as path, pg_catalog.current_schemas(true)::text[] as schemas,
          (select n.nspname::text from pg_catalog.pg_namespace n where n.oid = pg_catalog.pg_my_temp_schema()) as temp`,
    );
    try {
      let tabellen = optionen.tabellen;
      if (typeof tabellen === "function") {
        await abfrage("select pg_catalog.set_config('search_path', $1, true)", [schema]);
        tabellen = await tabellen(abfrage);
      }
      await abfrage("select pg_catalog.set_config('search_path', 'pg_catalog', true)");
      const katalog = await leseKatalogobjekte(abfrage, schema);
      const triggers = await abfrage<Sollbestand["triggers"][number]>(
        `
        select format('%I.%I', n.nspname, c.relname) as "table", t.tgname as name, t.tgenabled as enabled,
          pg_get_triggerdef(t.oid, false) as definition,
          format('%I.%I(%s)', pn.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as function
        from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_proc p on p.oid = t.tgfoid join pg_catalog.pg_namespace pn on pn.oid = p.pronamespace
        where n.nspname = $1::text and not t.tgisinternal order by n.nspname, c.relname, t.tgname`,
        [schema],
      );
      // prosrc ist bei SQL-Standardrümpfen leer; der zusätzliche Definitionshash deckt auch diese ab.
      // proconfig, Sprache und SECURITY DEFINER können die Wirkung ohne Änderung von prosrc verändern.
      // https://www.postgresql.org/docs/18/catalog-pg-proc.html
      const functions = await abfrage<{
        name: string;
        source: string;
        definition: string;
        config: string[];
        language: string;
        securityDefiner: boolean;
      }>(
        `
        select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as name,
          p.prosrc as source, pg_get_functiondef(p.oid) as definition, coalesce(p.proconfig, '{}'::text[]) as config,
          l.lanname as language, p.prosecdef as "securityDefiner"
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace join pg_catalog.pg_language l on l.oid = p.prolang
        where (n.nspname = $1::text and left(p.proname, length($2::text)) = $2::text)
          or p.oid in (select t.tgfoid from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
            join pg_catalog.pg_namespace tn on tn.oid = c.relnamespace where tn.nspname = $1::text and not t.tgisinternal)
        order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)`,
        [schema, `${praefix}_`],
      );
      const bestand: Sollbestand = {
        triggers: [...triggers],
        functions: functions.map(({ source, definition, ...fn }) => ({
          ...fn,
          config: [...fn.config].sort(),
          sourceHash: sha256(source),
          definitionHash: sha256(definition),
        })),
        sealedTables: tabellen,
        defaults: await leseStandardwerte(abfrage, schema, tabellen),
        builtins: await leseEingebaute(abfrage),
        extensions: erweiterungsmitglieder(katalog),
      };
      return {
        bestand,
        replica: await leseReplicaVorgaben(abfrage),
        suchpfad: einstellung!.schemas,
        temp: einstellung!.temp,
        katalog,
        zeilensicherheit: await leseZeilensicherheit(abfrage, schema),
      };
    } finally {
      await abfrage("select pg_catalog.set_config('search_path', $1, true)", [einstellung!.path]);
    }
  });
}

/** Der Bestand einer frisch migrierten Datenbank, als Sollbestand zum Ausliefern */
export async function leseSollbestand(leser: Leser, optionen: LeseOptionen): Promise<Sollbestand> {
  return (await leseMomentaufnahme(leser, optionen)).bestand;
}

/**
 * Standardwerte der Spalten der genannten Tabellen aus dem Katalog. An ihnen misst eine Prüfung der Siegel, was ein älteres
 * Siegel nicht abdeckt (bei Haben 0310_siegel_unabgedeckte_spalten.sql). Erwartet search_path = pg_catalog wie die
 * Triggerdefinitionen, damit Typnamen im Ausdruck eindeutig sind. pg_attrdef enthält auch den Ausdruck einer erzeugten
 * Spalte; Haben liest ihn dort wie einen Standardwert, deshalb gehört er hier dazu.
 * https://www.postgresql.org/docs/18/catalog-pg-attrdef.html
 * https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-INFO-CATALOG-TABLE
 */
async function leseStandardwerte(abfrage: Abfrage, schema: string, tabellen: string[]): Promise<Standardwert[]> {
  const zeilen = await abfrage<Standardwert>(
    `
    select format('%I.%I', n.nspname, c.relname) as "table", a.attname as "column", pg_get_expr(d.adbin, d.adrelid) as expression
    from pg_catalog.pg_attrdef d join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    join pg_catalog.pg_class c on c.oid = d.adrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1::text and not a.attisdropped
    order by n.nspname, c.relname, a.attname`,
    [schema],
  );
  const gesucht = new Set(tabellen);
  return zeilen.filter((zeile) => gesucht.has(zeile.table));
}

/**
 * Dauerhafte Vorgaben wirken wie abgeschaltete normale Trigger. Nur SET in einer Sitzung ist keine solche Vorgabe.
 * reset_val erfasst auch die geladene Serverkonfiguration; Rollen-/Datenbankvorgaben stehen im gemeinsamen Katalog.
 * local feuert dieselben Trigger wie origin und ist deshalb kein Befund. Sortiert nach Bereich, Rolle und Datenbank, eine Rolle
 * für alle Datenbanken vor derselben Rolle in dieser Datenbank.
 * https://www.postgresql.org/docs/18/catalog-pg-db-role-setting.html
 * https://www.postgresql.org/docs/18/view-pg-settings.html
 * https://www.postgresql.org/docs/18/runtime-config-client.html#GUC-SESSION-REPLICATION-ROLE
 */
async function leseReplicaVorgaben(abfrage: Abfrage): Promise<ReplicaVorgabe[]> {
  const zeilen = await abfrage<{ bereich: ReplicaVorgabe["bereich"]; rolle: string | null; datenbank: string | null }>(`
    select bereich, rolle, datenbank from (
      select 'verbindung' as bereich, null::text as rolle, null::text as datenbank
      from pg_catalog.pg_settings
      where name = 'session_replication_role' and reset_val = 'replica'
      union all
      select case when s.setrole = 0 then 'datenbank' else 'rolle' end as bereich,
        case when s.setrole = 0 then null else pg_catalog.quote_ident(r.rolname) end as rolle,
        case when s.setrole <> 0 and s.setdatabase = 0 then null else pg_catalog.current_database()::text end as datenbank
      from pg_catalog.pg_db_role_setting s left join pg_catalog.pg_roles r on r.oid = s.setrole
      cross join lateral pg_catalog.unnest(s.setconfig) as config(value)
      where s.setdatabase in (0, (select oid from pg_catalog.pg_database where datname = pg_catalog.current_database()))
        and pg_catalog.split_part(config.value, '=', 1) = 'session_replication_role'
        and pg_catalog.lower(pg_catalog.split_part(config.value, '=', 2)) = 'replica'
    ) vorgaben
    order by bereich, rolle, datenbank nulls first`);
  return zeilen.map(({ bereich, rolle, datenbank }): ReplicaVorgabe => {
    if (bereich === "verbindung") return { bereich };
    if (bereich === "datenbank") return { bereich, datenbank: datenbank! };
    return { bereich, rolle: rolle!, datenbank };
  });
}

/*
 * Zeilensicherheit (Row Level Security): Der Eigentümer einer Tabelle kann sie einschalten und mit einer Policy Zeilen vor
 * Rollen verbergen, die nicht Eigentümer sind, also auch vor der App-Anmeldung bei getrennten Rollen. Ein festgeschriebener
 * Datensatz und sein Siegel verschwänden dann aus der App und aus den Prüfungen, die von Datensätzen oder Siegeln ausgehen;
 * mit FORCE gilt das auch für den Eigentümer. Erwartet search_path = pg_catalog wie die übrigen Abfragen des Sollbestands.
 * https://www.postgresql.org/docs/18/ddl-rowsecurity.html
 * https://www.postgresql.org/docs/18/catalog-pg-policy.html
 */
async function leseZeilensicherheit(abfrage: Abfrage, schema: string): Promise<Zeilensicherheit> {
  const tables = await abfrage<Zeilensicherheit["tables"][number]>(
    `
    select c.relname::text as "table", c.relrowsecurity as enabled, c.relforcerowsecurity as forced
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1::text and c.relkind in ('r', 'p') and (c.relrowsecurity or c.relforcerowsecurity)`,
    [schema],
  );
  const policies = await abfrage<Zeilensicherheit["policies"][number]>(
    `
    select c.relname::text as "table", p.polname::text as name
    from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1::text`,
    [schema],
  );
  return { tables: [...tables], policies: [...policies] };
}
