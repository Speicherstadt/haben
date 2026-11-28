import { computeInvoice, discountFromColumns, totalsFromTaxes, type InvoiceTotals } from "@haben/core";
import { asc, eq } from "drizzle-orm";
import { schema, type Tx } from "../../db/index.ts";
import { reductionProblem } from "./correction-checks.ts";
import { lineInputOf } from "./invoice-drafts.ts";
import { InvoiceError } from "./invoice-error.ts";
import { correctionBasis, correctionTaxes, sameTaxRows, storeInvoiceTaxes } from "./invoice-taxes.ts";
import type { Invoice, InvoiceLine } from "./invoices.ts";

/*
 * Steuer einer Korrektur beim Festschreiben neu aus dem Gesamtstand (#2079): Seit dem Speichern des Entwurfs kann eine
 * andere Korrektur derselben Rechnung festgeschrieben worden sein. Gerechnet wird unter der Sperre der Rechnung
 * (prepareReferences), gespeichert erst nach dem Rendern von PDF und XML: Bis dahin bleibt die Hash-Kette frei und die
 * Sperren folgen der Reihenfolge Rechnung, Nummernkreis, Hash-Kette (number-counter.ts).
 */

export interface CorrectionRecalculation {
  lineNets: number[];
  taxes: ReturnType<typeof correctionTaxes>["taxes"];
  /** In Euro, für Buchung und Spalten der Rechnung */
  totals: InvoiceTotals;
  /** In der Währung der Rechnung, für PDF und XML */
  documentTotals: InvoiceTotals;
}

/** Neu gerechnete Werte einer Korrektur; null, wenn es keine Korrektur ist oder sich nichts geändert hat */
export async function correctionRecalculation(tx: Tx, invoice: Invoice, rows: InvoiceLine[]): Promise<CorrectionRecalculation | null> {
  if (invoice.kind !== "korrektur" || !invoice.correctsId) return null;
  const lines = rows.map((line) => ({ ...lineInputOf(line), ...(line.deductionOf ? { deductionOf: line.deductionOf } : {}) }));
  const own = computeInvoice(lines, invoice.priceMode, discountFromColumns(invoice.discountPercent, invoice.discountAmount));
  const basis = await correctionBasis(tx, invoice.correctsId);
  const { calculation, taxes } = correctionTaxes(own, lines, invoice.priceMode, basis, invoice.currency, invoice.exchangeRate);
  const stored = await tx.select().from(schema.invoiceTaxes).where(eq(schema.invoiceTaxes.invoiceId, invoice.id));
  if (sameTaxRows(stored, taxes) && rows.every((line, i) => line.net === calculation.lineNets[i])) return null;
  return {
    lineNets: calculation.lineNets,
    taxes,
    totals: totalsFromTaxes(taxes),
    documentTotals: totalsFromTaxes(taxes.map((t) => (t.originalBase === null ? t : { rate: t.rate, base: t.originalBase, tax: t.originalTax ?? 0 }))),
  };
}

/** Gespeicherte Positionen mit dem neu gerechneten Zeilennetto, für PDF und XML */
export const withRecalculatedNets = (rows: InvoiceLine[], recalculated: CorrectionRecalculation | null): InvoiceLine[] =>
  recalculated ? rows.map((line, i) => ({ ...line, net: recalculated.lineNets[i]! })) : rows;

/**
 * Speichert die neu gerechneten Werte und prüft danach, was finalizeIssues auf dem alten Stand geprüft hat: Die Korrektur
 * muss weiter mindern, und sie darf die Rechnung nicht unter 0 mindern oder als unbezahlte ganz aufheben.
 */
export async function storeCorrectionRecalculation(tx: Tx, invoice: Invoice, original: Invoice, recalculated: CorrectionRecalculation): Promise<void> {
  const rows = await tx.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoice.id)).orderBy(asc(schema.invoiceLines.position));
  for (const [i, line] of rows.entries()) {
    const net = recalculated.lineNets[i]!;
    if (line.net !== net) await tx.update(schema.invoiceLines).set({ net }).where(eq(schema.invoiceLines.id, line.id));
  }
  await storeInvoiceTaxes(tx, invoice.id, recalculated.taxes);
  if (recalculated.totals.gross >= 0) throw new InvoiceError("Noch nicht bereit: Eine Rechnungskorrektur muss den Betrag mindern.");
  const problem = await reductionProblem(invoice, original, tx);
  if (problem) throw new InvoiceError(`${problem}.`);
}
