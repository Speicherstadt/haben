import { PRIVATENTNAHME } from "@haben/core";
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/*
 * Kategorie und eigenes Konto eines Belegs in einer Abfrage (#1975, docs/adr/belege-positionen.md), für Leser, die in SQL
 * filtern oder zählen: Anlagen in der EÜR, Skonto, Belegliste, Kontakthistorie. Ein Beleg mit Positionen trägt seine
 * Kontierung nur in document_splits; ein festgeschriebener aus der Zeit davor noch in documents. Wie belegKategorie und
 * einzigePosition in modules/belege/positionen.ts zählt eine Kontierung aus Kategorie und eigenem Konto, Entnahmen
 * ausgenommen. Beträge rechnen die Ausdrücke nicht; die bleiben bei den Funktionen dort. Hier und nicht im Modul belege,
 * weil auch Module darunter (bank, umsatzsteuer) sie brauchen.
 */

/** Kontierung einer Position als Text: Kategorie und eigenes Konto */
const kontierung = sql`coalesce(s.category, '') || '|' || coalesce(s.own_account_id::text, '')`;

/** Wert der einen betrieblichen Kontierung eines Belegs: Positionen ohne Entnahmen; null bei mehreren oder keiner */
const einzigeKontierungSql = (id: AnyPgColumn | SQL, spalte: SQL) =>
  sql`(select case when count(distinct ${kontierung}) = 1 then min(${spalte}) end
    from document_splits s where s.document_id = ${id} and s.category is distinct from ${PRIVATENTNAHME})`;

/**
 * Kategorie eines Belegs in einer Abfrage, für Leser, die in SQL filtern oder zählen (Anlagen, Liste, Vorschläge): die
 * Kategorie seiner einen Kontierung wie belegKategorie, beim Altbestand die am Beleg, null bei mehreren. Beträge rechnet
 * der Ausdruck nicht.
 */
export function belegKategorieSql(id: AnyPgColumn | SQL, category: AnyPgColumn | SQL): SQL<string | null> {
  return sql<string | null>`coalesce(${category}, ${einzigeKontierungSql(id, sql`s.category`)})`;
}

/** Eigenes Konto der einen Kontierung als „Nummer Name“, beim Altbestand das am Beleg; null ohne eigenes Konto */
export function belegKontoSql(id: AnyPgColumn | SQL, ownAccountId: AnyPgColumn | SQL): SQL<string | null> {
  return sql<string | null>`(select o.account || ' ' || o.name from own_accounts o
    where o.id = coalesce(${ownAccountId}, ${einzigeKontierungSql(id, sql`s.own_account_id::text`)}::uuid))`;
}

/**
 * Zahl der Positionen eines Belegs, der keine eine Kontierung hat (mehrere, oder nur Entnahmen); 0 mit einer oder ohne
 * Positionen, wie früher ohne Aufteilung
 */
export function belegAufteilungSql(id: AnyPgColumn | SQL): SQL<number> {
  return sql<number>`(select case when count(*) = 0 or count(distinct ${kontierung}) filter (where s.category is distinct from ${PRIVATENTNAHME}) = 1
    then 0 else count(*)::int end from document_splits s where s.document_id = ${id})`;
}
