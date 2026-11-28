import { cancellationProblem } from "@haben/core";
import { and, eq, ne, sql } from "drizzle-orm";
import { db, schema, type Db, type Tx } from "../../db/index.ts";
import { today } from "../../today.ts";
import { deductedElsewhere } from "./advance-deductions.ts";
import { listInvoices, type Invoice } from "./invoices.ts";

/* Was gegen Storno oder Korrektur einer Rechnung spricht; geprüft beim Anlegen und beim Festschreiben */

/** Was gegen Storno oder Korrektur einer Rechnung spricht; null = in Ordnung */
export async function originalProblem(original: Invoice, q: Db | Tx = db, of?: Invoice): Promise<string | null> {
  if (original.lexofficeVoucherId) {
    const [source] = await q
      .select({ source: schema.lexofficeVouchers.source })
      .from(schema.lexofficeVouchers)
      .where(eq(schema.lexofficeVouchers.id, original.lexofficeVoucherId));
    if (source?.source === "import")
      return "Diese Rechnung wurde mit fremden Originalbuchungen übernommen. Eine Korrektur muss zuerst mit diesen abgestimmt werden.";
  }
  const [storno] = await q
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.correctsId, original.id), eq(schema.invoices.kind, "storno"), eq(schema.invoices.status, "final")))
    .limit(1);
  const deductedIn = (await deductedElsewhere([original.id], null, q)).get(original.id) ?? null;
  // Das Storno einer Korrektur entsteht nur zusammen mit dem Storno ihrer Rechnung (cancelInvoice)
  const kinds = of?.kind === "storno" ? (["rechnung", "korrektur"] as const) : (["rechnung"] as const);
  return cancellationProblem(original, { cancelled: Boolean(storno), deductedIn }, kinds);
}

/** Mehrere Korrekturen zusammen mindern eine Rechnung höchstens bis auf 0, netto (die Steuer rundet jeder Beleg für sich) */
export async function reductionProblem(invoice: Invoice, original: Invoice, q: Db | Tx = db): Promise<string | null> {
  if (invoice.kind !== "korrektur") return null;
  const corrections = await correctionSums(invoice, original, q);
  if (original.net + corrections.net + invoice.net < 0) return "Die Korrekturen mindern die Rechnung unter 0";
  return aufgehobenProblem(invoice, original, corrections, q);
}

/**
 * Eine Korrektur, die eine noch unbezahlte Rechnung genau aufhebt, ist ein Storno (#877, #2037). Das wird schon beim
 * Festschreiben abgewiesen, weil der Beleg danach versiegelt ist und nur noch ein Storno der Rechnung hilft.
 *
 * Gerechnet wird brutto, weil der Kunde den Bruttobetrag schuldet, und zwar auf der festgeschriebenen Rechnung:
 * `invoiceOpen` liefert 0, sobald der Beleg kein Festschreiben ist, deshalb darf hier nie der Entwurf stehen.
 * „Nichts bezahlt" heißt offener Rest gleich Rechnungsbetrag; Ausbuchungen und Verrechnungen zählen als Zahlung.
 */
async function aufgehobenProblem(invoice: Invoice, original: Invoice, corrections: { net: number; gross: number }, q: Db | Tx): Promise<string | null> {
  const brutto = original.gross + corrections.gross + invoice.gross;
  if (brutto !== 0) return null;
  const [offen] = await listInvoices(today(), original.id, q);
  if (offen?.open !== original.gross) return null;
  return "Diese Korrektur hebt die ganze Rechnung auf. Das ist ein Storno: storniere die Rechnung, statt die Korrektur festzuschreiben";
}

/** Summen der festgeschriebenen Korrekturen einer Rechnung ohne die eigene Zeile, netto und brutto in einer Abfrage */
async function correctionSums(invoice: Invoice, original: Invoice, q: Db | Tx): Promise<{ net: number; gross: number }> {
  const [row] = await q
    .select({
      net: sql<number>`coalesce(sum(${schema.invoices.net}), 0)::int`,
      gross: sql<number>`coalesce(sum(${schema.invoices.gross}), 0)::int`,
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.correctsId, original.id),
        eq(schema.invoices.kind, "korrektur"),
        eq(schema.invoices.status, "final"),
        ne(schema.invoices.id, invoice.id),
      ),
    );
  return { net: row!.net, gross: row!.gross };
}
