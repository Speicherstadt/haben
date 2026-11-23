import { createHash } from "node:crypto";
import type { Abfrage } from "./verbindung.ts";

/** Name und Hash über die Definition */
export type Eintrag = { name: string; hash: string };

/** Selbst angelegte Funktion, Aggregat, Prozedur, Operator oder Cast */
export type Gefunden = Eintrag & { schema: string; proname: string; builtin: boolean; extension: boolean };

export interface Katalogobjekte {
  functions: Gefunden[];
  operators: Gefunden[];
  casts: Gefunden[];
  /** Relationen in pg_catalog und gleichnamige zu Tabellen des geprüften Schemas im temporären Schema der Sitzung */
  relations: { name: string; schema: string }[];
}

/** Mitglieder der Erweiterungen einer frischen Installation */
export type Erweiterungen = { functions: Eintrag[]; operators: Eintrag[]; casts: Eintrag[] };

/** Eingebaute Funktionen in pg_catalog, die nicht in C fest eingebaut sind, mit einem Hash über ihre Definition */
export type Eingebaute = { major: number; functions: Eintrag[] };

const digest = (definition: object) => createHash("sha256").update(JSON.stringify(definition)).digest("hex");
// Sortiert ohne Sortierfolge der Datenbank, damit der Sollbestand nicht von ihrer Locale abhängt
const nachName = (a: Eintrag, b: Eintrag) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const mitHash = <T extends { name: string }>(zeilen: T[], ohne: (keyof T)[]) =>
  zeilen.map((zeile) => {
    const definition = Object.fromEntries(Object.entries(zeile).filter(([key]) => !ohne.includes(key as keyof T)));
    return { ...zeile, hash: digest(definition) };
  });

/**
 * Definition einer Funktion für den Hash. Einen Rumpf in SQL-Standard-Schreibweise (RETURN, BEGIN ATOMIC) hat prosrc nicht,
 * er steht in prosqlbody. https://www.postgresql.org/docs/18/catalog-pg-proc.html
 */
const funktionsdefinition = `p.prokind, l.lanname, p.prosecdef, p.proleakproof, p.proisstrict, p.proretset, p.provolatile,
  p.proparallel, format_type(p.prorettype, null) as rettype, p.prosrc, p.probin, pg_get_function_sqlbody(p.oid) as sqlbody,
  coalesce(p.proconfig, '{}'::text[]) as config`;
const mitglied = (katalog: string, spalte: string) =>
  `exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_catalog.${katalog}'::pg_catalog.regclass
    and d.objid = ${spalte} and d.deptype = 'e')`;

/*
 * Objekte, die jemand angelegt hat. Die Prüffunktionen rufen eingebaute Funktionen ohne Schema auf. Eine Funktion mit genau
 * passenden Argumenttypen geht dabei einer polymorphen vor, egal in welchem Schema des Suchpfads sie steht; ein Superuser
 * kann sie auch in pg_catalog anlegen. Ein Cast in json ändert, was to_jsonb aus einem eigenen Typ macht. Selbst angelegte
 * Objekte haben eine OID ab FirstNormalObjectId (16384), eingebaute darunter. Mitglied einer Erweiterung zu sein, belegt
 * keine Herkunft: Ihr Eigentümer kann jedes eigene Objekt aufnehmen (ALTER EXTENSION … ADD). Deshalb lesen die Abfragen
 * auch Mitglieder, mit einem Hash über ihre Definition für den Vergleich mit dem Sollbestand.
 * Erwartet search_path = pg_catalog wie die übrigen Abfragen des Sollbestands.
 * https://www.postgresql.org/docs/18/typeconv-func.html
 * https://www.postgresql.org/docs/18/functions-json.html (to_jsonb)
 * https://www.postgresql.org/docs/18/sql-alterextension.html
 * https://github.com/postgres/postgres/blob/REL_18_STABLE/src/include/access/transam.h (FirstNormalObjectId)
 */
export async function leseKatalogobjekte(abfrage: Abfrage, schema: string): Promise<Katalogobjekte> {
  const ohne = ["name", "schema", "proname", "builtin", "extension"] as const;
  const functions = await abfrage<Omit<Gefunden, "hash">>(
    `
    select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as name, n.nspname as schema,
      p.proname::text as proname, exists (select 1 from pg_catalog.pg_proc b where b.oid < 16384 and b.proname = p.proname) as builtin,
      ${mitglied("pg_proc", "p.oid")} as extension, ${funktionsdefinition}
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace join pg_catalog.pg_language l on l.oid = p.prolang
    where p.oid >= 16384 and n.nspname in ($1::text, 'pg_catalog')`,
    [schema],
  );
  const operators = await abfrage<Omit<Gefunden, "hash">>(
    `
    select format('%I.%s(%s, %s)', n.nspname, o.oprname, case when o.oprleft = 0 then 'NONE' else format_type(o.oprleft, null) end,
        format_type(o.oprright, null)) as name, n.nspname as schema, o.oprname::text as proname,
      exists (select 1 from pg_catalog.pg_operator b where b.oid < 16384 and b.oprname = o.oprname) as builtin,
      ${mitglied("pg_operator", "o.oid")} as extension, format_type(o.oprresult, null) as result, o.oprcode::regprocedure::text as code,
      o.oprcom::regoperator::text as commutator, o.oprnegate::regoperator::text as negator, o.oprrest::text as restrict, o.oprjoin::text as join
    from pg_catalog.pg_operator o join pg_catalog.pg_namespace n on n.oid = o.oprnamespace
    where o.oid >= 16384 and n.nspname in ($1::text, 'pg_catalog')`,
    [schema],
  );
  const casts = await abfrage<Omit<Gefunden, "hash">>(`
    select format('%s → %s', format_type(c.castsource, null), format_type(c.casttarget, null)) as name, '' as schema, '' as proname,
      false as builtin, ${mitglied("pg_cast", "c.oid")} as extension, c.castfunc::regprocedure::text as function, c.castcontext, c.castmethod
    from pg_catalog.pg_cast c
    where c.oid >= 16384`);
  // Die Prüffunktionen nennen auch Tabellen ohne Schema. Für Relationen stehen das temporäre Schema der Sitzung und
  // pg_catalog im Suchpfad vor dem geprüften Schema; nach pg_catalog kann ein Superuser eine Sicht mit SET SCHEMA verschieben.
  const relations = await abfrage<{ name: string; schema: string }>(
    `
    select format('%I.%I', n.nspname, c.relname) as name, n.nspname::text as schema
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.oid >= 16384 and (n.nspname = 'pg_catalog' or (c.relnamespace = pg_my_temp_schema() and exists (
      select 1 from pg_catalog.pg_class p join pg_catalog.pg_namespace pn on pn.oid = p.relnamespace where pn.nspname = $1::text and p.relname = c.relname)))
    order by c.oid`,
    [schema],
  );
  const sortiert = (zeilen: Omit<Gefunden, "hash">[]) => mitHash(zeilen, [...ohne]).sort(nachName);
  return { functions: sortiert([...functions]), operators: sortiert([...operators]), casts: sortiert([...casts]), relations: [...relations] };
}

/** Mitglieder von Erweiterungen, für den Sollbestand aus einer frisch migrierten Datenbank */
export function erweiterungsmitglieder(objekte: Katalogobjekte): Erweiterungen {
  const eintraege = (liste: Gefunden[]) => liste.filter((eintrag) => eintrag.extension).map(({ name, hash }) => ({ name, hash }));
  return { functions: eintraege(objekte.functions), operators: eintraege(objekte.operators), casts: eintraege(objekte.casts) };
}

/*
 * Ein Superuser kann eine eingebaute Funktion an Ort und Stelle ersetzen (CREATE OR REPLACE in pg_catalog); ihre OID
 * bleibt dabei unter FirstNormalObjectId. Fest eingebaute Funktionen (Sprache internal) unterscheiden sich zwischen
 * Unterversionen (18.7 hat eine mehr als 18.6). Die übrigen, in SQL oder als C-Bibliothek, waren in 18.4, 18.6 und 18.7
 * gleich. Eine ersetzte Funktion fällt deshalb so auf: Eigener Code in SQL oder PL/pgSQL macht aus einer fest eingebauten
 * eine zusätzliche Funktion dieser Gruppe, an einer Funktion der Gruppe ändert er den Hash. Eine fest eingebaute Funktion
 * ruft PostgreSQL über ihre OID aus der eingebauten Tabelle auf, ohne pg_proc zu lesen; eine Umleitung auf eine andere fest
 * eingebaute oder geänderte Eigenschaften wirken deshalb nicht.
 * https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/utils/fmgr/fmgr.c (fmgr_isbuiltin)
 * Erwartet search_path = pg_catalog wie die übrigen Abfragen des Sollbestands.
 */
export async function leseEingebaute(abfrage: Abfrage): Promise<Eingebaute> {
  const [version] = await abfrage<{ major: number }>("select current_setting('server_version_num')::integer / 10000 as major");
  const zeilen = await abfrage<{ name: string }>(`
    select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as name, ${funktionsdefinition}
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace join pg_catalog.pg_language l on l.oid = p.prolang
    where p.oid < 16384 and n.nspname = 'pg_catalog' and l.lanname <> 'internal'`);
  const functions = mitHash([...zeilen], ["name"]).map(({ name, hash }) => ({ name, hash }));
  return { major: Number(version!.major), functions: functions.sort(nachName) };
}
