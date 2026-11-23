import { periodRange, type TaxTreatment, type VatPeriod } from "@haben/core";
import { and, eq, gte, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { schema, type Db, type Tx } from "../../db/index.ts";
import { invoiceTaxReader, invoiceTotalsById, leistungstag } from "../rechnungen/index.ts";
import type { RevenueSource } from "./vat-figures.ts";

/*
 * Belege, die die Voranmeldung im Zeitraum der Leistung meldet (Kz 43 und 48, umsaetze-nach-leistung.ts): Rechnungen,
 * Stornos und Korrekturen nach dem Leistungstag (leistungstag in rechnungen), die Schlussrechnung mit den abgezogenen
 * Anzahlungen, Skonto und Forderungsausfall im Monat der Ausbuchung. Welche Belege zählen, entscheidet der Aufrufer.
 */

export type Rechnung = typeof schema.invoices.$inferSelect;
export type Taxes = ReturnType<typeof invoiceTaxReader>;
/** Ob ein Beleg der Behandlung im Zeitraum der Leistung zählt */
export type Zaehlt = (r: Rechnung, taxes: Taxes) => Promise<boolean>;

export const summe = (quellen: readonly RevenueSource[]) => quellen.reduce((s, r) => s + r.base, 0);

/** Rechnungen, Stornos und Korrekturen der Behandlungen mit Leistung im Zeitraum, je Beleg mit dem Entgelt der Leistung */
export async function rechnungenNachLeistung(period: VatPeriod, behandlungen: readonly TaxTreatment[], zaehlt: Zaehlt, q: Db | Tx): Promise<RevenueSource[]> {
  const { start, end } = periodRange(period);
  const i = schema.invoices;
  const imZeitraum = (spalte: typeof i.issueDate | typeof i.serviceDate | typeof i.serviceFrom | typeof i.serviceTo) =>
    and(gte(spalte, start), lt(spalte, end));
  const kandidaten = await q
    .select()
    .from(i)
    .where(
      and(
        eq(i.status, "final"),
        inArray(i.taxTreatment, [...behandlungen]),
        // aus Lexoffice übernommen: dort schon gemeldet
        isNull(i.lexofficeVoucherId),
        or(imZeitraum(i.issueDate), imZeitraum(i.serviceDate), imZeitraum(i.serviceFrom), imZeitraum(i.serviceTo)),
      ),
    );
  const rechnungen = kandidaten.filter((r) => leistungstag(r) >= start && leistungstag(r) < end);
  if (rechnungen.length === 0) return [];
  const taxes = invoiceTaxReader(q);
  const zaehlen: Rechnung[] = [];
  for (const r of rechnungen) if (await zaehlt(r, taxes)) zaehlen.push(r);
  const ids = zaehlen.map((r) => r.id);
  const totals = await invoiceTotalsById(ids, q);
  // Die Schlussrechnung zieht Abschläge als eigene Positionen ab; abgezogene Anzahlungen gehören zum Entgelt der Leistung,
  // abgezogene Teilleistungen nicht (sie zählen im Monat ihrer eigenen Leistung)
  const abzuege = await anzahlungsAbzuege(ids, q);
  return zaehlen.map((r) => ({
    type: "invoice",
    date: leistungstag(r),
    invoiceId: r.id,
    number: r.number ?? "",
    customer: r.buyer?.name ?? "",
    treatment: r.taxTreatment,
    exemptionReason: r.exemptionReason,
    rate: 0,
    base: (totals.get(r.id)?.net ?? 0) - (abzuege.get(r.id) ?? 0),
    tax: 0,
  }));
}

/** Skonto und Forderungsausfall auf Rechnungen der Behandlungen im Zeitraum, samt Aufhebung (mit umgekehrtem Vorzeichen) */
export async function ausbuchungenNachLeistung(period: VatPeriod, behandlungen: readonly TaxTreatment[], zaehlt: Zaehlt, q: Db | Tx): Promise<RevenueSource[]> {
  const { start, end } = periodRange(period);
  const w = schema.writeOffs;
  const i = schema.invoices;
  const rows = await q
    .select({ date: w.date, amount: w.amount, rechnung: i })
    .from(w)
    .innerJoin(i, eq(i.id, w.invoiceId))
    .where(
      and(
        inArray(w.kind, ["skonto", "forderungsausfall"]),
        gte(w.date, start),
        lt(w.date, end),
        inArray(i.taxTreatment, [...behandlungen]),
        isNull(i.lexofficeVoucherId),
      ),
    );
  const taxes = invoiceTaxReader(q);
  const result: RevenueSource[] = [];
  for (const { date, amount, rechnung } of rows) {
    // Was nicht im Zeitraum der Leistung zählt (Anzahlung, Leistung vor 2025 als Kleinunternehmer), mindert die Ausbuchung auch nicht
    if (!(await zaehlt(rechnung, taxes))) continue;
    result.push({
      type: "ausbuchung",
      date,
      invoiceId: rechnung.id,
      number: rechnung.number ?? "",
      customer: rechnung.buyer?.name ?? "",
      treatment: rechnung.taxTreatment,
      exemptionReason: rechnung.exemptionReason,
      rate: 0,
      base: -amount,
      tax: 0,
    });
  }
  return result;
}

/** Je Rechnung die Summe ihrer Abzugspositionen für Anzahlungen (negativ) */
export async function anzahlungsAbzuege(ids: string[], q: Db | Tx): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const l = schema.invoiceLines;
  const abschlag = schema.invoices;
  const rows = await q
    .select({ invoiceId: l.invoiceId, net: l.net })
    .from(l)
    .innerJoin(abschlag, eq(abschlag.id, l.deductionOf))
    .where(and(inArray(l.invoiceId, ids), ne(abschlag.advanceType, "teilleistung")));
  const result = new Map<string, number>();
  for (const r of rows) result.set(r.invoiceId, (result.get(r.invoiceId) ?? 0) + r.net);
  return result;
}
