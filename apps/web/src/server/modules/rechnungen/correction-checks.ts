import { cancellationProblem } from "@haben/core";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
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

/**
 * Mehrere Korrekturen zusammen mindern eine Rechnung höchstens bis auf 0. Gerechnet wird das Netto in der Währung der
 * Rechnung: Die Steuer folgt daraus (Gesamtstand, #2079), der Euro-Betrag rundet je Beleg; das Netto entscheidet.
 */
export async function reductionProblem(invoice: Invoice, original: Invoice, q: Db | Tx = db): Promise<string | null> {
  if (invoice.kind !== "korrektur") return null;
  const rest = await nettoInRechnungswaehrung(invoice, original, q);
  if (rest < 0) return "Die Korrekturen mindern die Rechnung unter 0";
  return rest === 0 ? aufgehobenProblem(original, q) : null;
}

/**
 * Eine Korrektur, die eine noch unbezahlte Rechnung genau aufhebt, ist ein Storno (#877, #2037). Das wird schon beim
 * Festschreiben abgewiesen, weil der Beleg danach versiegelt ist und nur noch ein Storno der Rechnung hilft.
 *
 * Aufgehoben ist die Rechnung, wenn das Netto von Rechnung und allen Korrekturen in der Währung der Rechnung 0 ergibt;
 * Steuer und Brutto in dieser Währung sind dann ebenfalls 0, weil die Korrektur ihre Steuer aus dem Gesamtstand rechnet
 * (#2079).
 * „Nichts bezahlt" heißt offener Rest gleich Rechnungsbetrag, gelesen auf der festgeschriebenen Rechnung (`invoiceOpen`
 * liefert für einen Entwurf 0); Ausbuchungen und Verrechnungen zählen als Zahlung, ebenso eine als bereits bezahlt
 * ausgestellte Rechnung, deren Zahlung erst der Bankabgleich zuordnet.
 * Eine Schlussrechnung zieht immer Abschläge ab: Die Korrektur ihres ganzen Rests lässt den Abschlag als Entgelt stehen,
 * erst ein Storno gibt ihn wieder frei. Sie ist deshalb keine Aufhebung der Leistung.
 */
async function aufgehobenProblem(original: Invoice, q: Db | Tx): Promise<string | null> {
  if (original.variant === "schluss" || original.paymentMethod === "bereits_bezahlt") return null;
  const [offen] = await listInvoices(today(), original.id, q);
  if (offen?.open !== original.gross) return null;
  return "Diese Korrektur hebt die ganze Rechnung auf. Das ist ein Storno: storniere die Rechnung, statt die Korrektur festzuschreiben";
}

/** Netto von Rechnung, festgeschriebenen Korrekturen und dieser Korrektur in der Währung der Rechnung, aus den Steuerzeilen */
async function nettoInRechnungswaehrung(invoice: Invoice, original: Invoice, q: Db | Tx): Promise<number> {
  const korrekturen = q
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.correctsId, original.id),
        eq(schema.invoices.kind, "korrektur"),
        eq(schema.invoices.status, "final"),
        ne(schema.invoices.id, invoice.id),
      ),
    );
  const [row] = await q
    .select({ net: sql<number>`coalesce(sum(coalesce(${schema.invoiceTaxes.originalBase}, ${schema.invoiceTaxes.base})), 0)::bigint` })
    .from(schema.invoiceTaxes)
    .where(or(inArray(schema.invoiceTaxes.invoiceId, [original.id, invoice.id]), inArray(schema.invoiceTaxes.invoiceId, korrekturen)));
  return Number(row!.net);
}
