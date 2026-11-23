import { eq } from "drizzle-orm";
import { db, schema, type Db, type Tx } from "../../db/index.ts";
import { invoiceTaxReader, invoiceVatDate } from "./invoice-tax.ts";
import { leistungsmonatHinweis } from "./leistungsmonat.ts";

/**
 * Hinweis zu einer festgeschriebenen Rechnung, nur wenn der Leistungstag ihre Meldung in einen Zeitraum verschiebt, dessen
 * zuletzt übermittelte Anmeldung vor dem Festschreiben gesendet wurde oder von Hand überschriebene Werte hatte. Ist-Versteuerung
 * (außer EU-Leistungen mit Reverse Charge, § 18b Satz 3 UStG, und steuerfreien Umsätzen in Kz 43 und 48, #1312), Anzahlungen,
 * Stornos und Korrekturen meldet Haben nicht nach dem Leistungstag.
 */
export async function leistungsmonatHinweisFuer(invoice: typeof schema.invoices.$inferSelect, q: Db | Tx = db): Promise<string | null> {
  if (invoice.status !== "final" || invoice.kind !== "rechnung") return null;
  const tag = await meldetag(invoice, q);
  if (tag === invoice.issueDate) return null;
  const gesendet = await q
    .select({
      year: schema.vatReturns.year,
      month: schema.vatReturns.month,
      sentAt: schema.vatReturns.sentAt,
      source: schema.vatReturns.source,
    })
    .from(schema.vatReturns)
    .where(eq(schema.vatReturns.status, "sent"))
    .orderBy(schema.vatReturns.sentAt);
  return leistungsmonatHinweis(tag, gesendet, { net: invoice.net, tax: invoice.tax }, invoice.lockedAt);
}

/**
 * Tag, nach dem die Voranmeldung die Rechnung meldet. § 4 UStG und Ausfuhr auch bei Ist nach dem Leistungstag, Anzahlungen
 * gar nicht (umsatzsteuer/umsaetze-nach-leistung.ts, Anleitung zur UStVA 2026 unter Kz 43 und 48)
 */
async function meldetag(invoice: typeof schema.invoices.$inferSelect, q: Db | Tx): Promise<string> {
  const steuerfrei = invoice.taxTreatment === "steuerfrei" || invoice.taxTreatment === "ausfuhr";
  if (!steuerfrei || invoice.lexofficeVoucherId !== null || (await invoiceTaxReader(q).companyMode(invoice)) !== "ist") return invoiceVatDate(invoice, q);
  if (invoice.advanceType === "anzahlung") return invoice.issueDate;
  return invoice.serviceDate ?? invoice.serviceTo ?? invoice.serviceFrom ?? invoice.issueDate;
}
