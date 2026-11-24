import { periodRange, type AdvanceVatChange, type TaxTreatment, type VatPeriod } from "@haben/core";
import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { schema, type Db, type Tx } from "../../db/index.ts";
import { anzahlungsAbzuege, invoiceTaxReader, invoiceTotalsById, leistungstag } from "../rechnungen/index.ts";
import type { RevenueSource } from "./vat-figures.ts";

/*
 * Belege, die die Voranmeldung im Zeitraum der Leistung meldet (Kz 43 und 48, umsaetze-nach-leistung.ts): Rechnungen,
 * Stornos und Korrekturen nach dem Leistungstag (leistungstag in rechnungen), die Schlussrechnung mit den abgezogenen
 * Anzahlungen, Skonto und Forderungsausfall im Monat der Ausbuchung, bis zur Rückzahlung gehaltene Minderungen. Welche
 * Belege zählen, entscheidet der Aufrufer.
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
  const imZeitraum = (spalte: typeof i.issueDate | typeof i.serviceDate) => and(gte(spalte, start), lt(spalte, end));
  const kandidaten = await q
    .select()
    .from(i)
    .where(
      and(
        eq(i.status, "final"),
        inArray(i.taxTreatment, [...behandlungen]),
        // aus Lexoffice übernommen: dort schon gemeldet
        isNull(i.lexofficeVoucherId),
        or(imZeitraum(i.issueDate), imZeitraum(i.serviceDate)),
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

/**
 * Bis zur Rückzahlung gehaltene Minderungen schon bezahlter Rechnungen der Behandlungen (`verlauf`, etwa
 * nachLeistungBisZurRueckzahlung in rechnungen): im Monat von Storno oder Korrektur als Gegenbetrag, mit der Rückzahlung
 * als Minderung. Nur Ketten mit einem Storno oder einer Korrektur mit Kennzeichen der Rückgewähr (#1228) vor dem Ende des
 * Zeitraums, vorher hält nichts.
 */
export async function gehalteneMinderungen(
  period: VatPeriod,
  behandlungen: readonly TaxTreatment[],
  zaehlt: Zaehlt,
  verlauf: (anfang: Rechnung, taxes: Taxes) => Promise<AdvanceVatChange[]>,
  q: Db | Tx,
): Promise<RevenueSource[]> {
  const { start, end } = periodRange(period);
  const anfaenge = await q.execute<{ id: string }>(sql`with recursive up(id, parent) as (
    select id, corrects_id from invoices
      where reduction_rule is not null and status = 'final' and tax_treatment in ${behandlungen} and issue_date < ${end}
    union select i.id, i.corrects_id from up join invoices i on i.id = up.parent
  ) select distinct id from up where parent is null`);
  if (anfaenge.length === 0) return [];
  const i = schema.invoices;
  const rechnungen = await q
    .select()
    .from(i)
    .where(
      and(
        inArray(
          i.id,
          [...anfaenge].map((r) => r.id),
        ),
        eq(i.status, "final"),
        inArray(i.taxTreatment, [...behandlungen]),
        isNull(i.lexofficeVoucherId),
      ),
    );
  const taxes = invoiceTaxReader(q);
  const result: RevenueSource[] = [];
  for (const r of rechnungen) {
    if (!(await zaehlt(r, taxes))) continue;
    for (const { date, shares } of await verlauf(r, taxes))
      if (date >= start && date < end)
        result.push({
          type: "invoice",
          date,
          invoiceId: r.id,
          number: r.number ?? "",
          customer: r.buyer?.name ?? "",
          treatment: r.taxTreatment,
          exemptionReason: r.exemptionReason,
          rate: 0,
          base: shares.reduce((s, x) => s + x.base, 0),
          tax: 0,
        });
  }
  return result;
}
