import type { KontoAbdeckung, OffeneVorgaenge } from "@haben/core";
import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema, type Db, type Tx } from "../../db/index.ts";
import { bankAccountIncludedSql, bankNotPrivateMarkedSql, bankOpenAmountSql, echterImport } from "../../db/bank-open.ts";

/*
 * Was in einem Zeitraum noch offen ist (#1635), für die Vorprüfung der Voranmeldung und die BWA gleich gezählt; die Hinweise
 * daraus rechnet packages/core/src/vollstaendigkeit.ts.
 */

/** Offene Bankumsätze, Belege „neu“ und Rechnungsentwürfe von `start` bis vor `endeAusschl`; Belege ohne Datum zählen immer */
export async function offeneVorgaenge(start: string, endeAusschl: string, q: Db | Tx = db): Promise<OffeneVorgaenge> {
  const t = schema.bankTransactions;
  // Verrechnete Umsätze (#457) sind erledigt wie zugeordnete
  const [bank] = await q
    .select({
      eingaenge: sql<number>`count(*) filter (where ${t.amount} > 0)::int`,
      ausgaben: sql<number>`count(*) filter (where ${t.amount} < 0)::int`,
    })
    .from(t)
    .where(
      and(
        gte(t.bookingDate, start),
        lt(t.bookingDate, endeAusschl),
        sql`${bankOpenAmountSql} <> 0`,
        bankNotPrivateMarkedSql,
        bankAccountIncludedSql("bank_account_id"),
      ),
    );
  const d = schema.documents;
  const [belege] = await q
    .select({ n: sql<number>`count(*)::int` })
    .from(d)
    .where(and(eq(d.status, "neu"), or(and(gte(d.documentDate, start), lt(d.documentDate, endeAusschl)), isNull(d.documentDate))));
  const i = schema.invoices;
  const [entwuerfe] = await q
    .select({ n: sql<number>`count(*)::int` })
    .from(i)
    .where(and(eq(i.status, "draft"), gte(i.issueDate, start), lt(i.issueDate, endeAusschl)));
  return { ausgaben: bank?.ausgaben ?? 0, eingaenge: bank?.eingaenge ?? 0, belege: belege?.n ?? 0, rechnungsentwuerfe: entwuerfe?.n ?? 0 };
}

/**
 * Wie weit die Umsätze je Konto reichen: das späteste Ende eines Imports, der letzte Umsatz oder bei einem Zahlungsdienstleister
 * mit Abruf der Tag vor dem letzten erfolgreichen Abruf (in Berlin), je nachdem, was später ist. Der Abruf speichert als Ende
 * nur seinen letzten Umsatz, ohne neue Umsätze gar keinen Import. Nach einem Fehler setzt der Zeitplan last_sync_at trotzdem,
 * deshalb zählt der Abruf nur ohne last_error. Nur Geschäfts-, Steuer- und Zahlungsdienstleisterkonten; private, Rücklage- und
 * ausgeschlossene Konten fließen nicht in die Auswertungen.
 */
export async function kontoAbdeckung(q: Db | Tx = db): Promise<KontoAbdeckung[]> {
  const a = schema.bankAccounts;
  return q
    .select({
      id: a.id,
      name: a.name,
      // Tabelle ausdrücklich nennen: in der Spaltenliste schreibt drizzle nur "id", das träfe in den Unterabfragen deren id
      bis: sql<string | null>`greatest(
        (select max(${schema.bankImports.periodTo}) from ${schema.bankImports} where ${schema.bankImports.bankAccountId} = ${a}.id and ${echterImport}),
        (select max(bt.booking_date) from bank_transactions bt where bt.bank_account_id = ${a}.id),
        (select max((c.last_sync_at at time zone 'Europe/Berlin')::date - 1) from psp_connections c
          where c.bank_account_id = ${a}.id and c.last_error is null))::text`,
    })
    .from(a)
    .where(and(isNull(a.excludedAt), inArray(a.purpose, ["geschaeft", "steuer", "zahlungsdienstleister"])))
    .orderBy(a.name);
}
