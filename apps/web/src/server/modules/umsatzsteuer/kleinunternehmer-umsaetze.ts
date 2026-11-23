import { periodRange, type JournalKennzahlen, type VatPeriod, type Versteuerung } from "@haben/core";
import { and, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { schema, type Db, type Tx } from "../../db/index.ts";
import { invoiceTaxReader, invoiceTotalsById, kleinunternehmerBisZurRueckzahlung } from "../rechnungen/index.ts";
import type { RevenueSource } from "./vat-figures.ts";
import { kennzahlenAusDemJournal } from "./vat-journal.ts";

/*
 * Umsätze als Kleinunternehmer in Kz 48 (#1268). Die Anleitung zur UStVA 2026 nennt unter Kz 48 die Umsätze nach § 19
 * Abs. 1 UStG (seit 2025 steuerfrei) und ordnet den Gesamtbetrag einschließlich Anzahlung und Restzahlung dem
 * Voranmeldungszeitraum der Leistungsausführung zu; Anzahlungen selbst meldet man nicht, eine Ausnahme für die
 * Ist-Versteuerung gibt es nicht (https://www.elster.de/eportal/helpGlobal?themaGlobal=help_ustva_2026#kz48). Das Journal
 * trägt diese Erlöse mit dem Steuerschlüssel „KU“, der in keine Kennzahl führt, bei Ist erst mit der Zahlung; die Summe
 * kommt deshalb aus den Rechnungen, bei Ist und Soll nach dem Leistungstag wie bei der Soll-Versteuerung: eingefroren beim
 * Festschreiben, sonst (vor Version 0.9) das Rechnungsdatum. Die Anleitung verlangt, Entgeltminderungen bei den
 * Bemessungsgrundlagen zu berücksichtigen (§ 17 UStG): Storno und Korrektur zählen im Monat ihres Datums, schon bezahltes
 * Entgelt mindern sie aber erst mit der Rückzahlung, wie in Kz 81 und 86 (#1228, UStAE 17.1 Abs. 2 Satz 3); Skonto und
 * Forderungsausfall buchen nur Unbezahltes aus und zählen im Monat der Ausbuchung. Bareinnahmen und direkt gebuchte
 * Erlöse ohne Rechnung zählen am Tag der Zahlung: Ohne Rechnung kennt Haben keinen anderen Tag (bareinnahme.ts,
 * direkt-kategorie.ts in @haben/core).
 *
 * Erst ab 2025: Vorher war ein Umsatz nach § 19 Abs. 1 nicht steuerfrei, Kz 48 der UStVA 2024 nennt nur § 4 Nr. 8 bis 29,
 * die der UStVA 2025 auch § 19 Abs. 1 (ERiC 44.3.6.0, UStVA-2024.xsd und UStVA-2025.xsd, Element Kz48). Storno, Korrektur
 * und Ausbuchung eines Umsatzes von 2024 mindern Kz 48 deshalb auch 2025 nicht.
 */

const STEUERFREI_AB = "2025-01-01";

type Rechnung = typeof schema.invoices.$inferSelect;
type Daten = Pick<Rechnung, "issueDate"> & Partial<Pick<Rechnung, "kind" | "serviceDate">>;

/**
 * Der beim Festschreiben eingefrorene Leistungstag (#694); ohne ihn, also bei Rechnungen von vor Version 0.9, wie bei Soll
 * das Rechnungsdatum (docs/umsatzsteuer.md, Leistungstag bei Soll-Versteuerung)
 */
const leistungstag = (r: Daten) => (r.kind === "rechnung" ? (r.serviceDate ?? r.issueDate) : r.issueDate);

/**
 * Ob ein Beleg in Kz 48 zählt; entscheidend ist der Anfang der Kette: Anzahlungen zählen nicht, auch nicht ihr Storno, ihre
 * Korrektur und deren Storno, das auf die Korrektur verweist (cancelInvoice), und Leistungen vor 2025 nicht
 */
async function zaehlt(r: Rechnung, taxes: ReturnType<typeof invoiceTaxReader>): Promise<boolean> {
  const anfang = await taxes.original(r);
  return anfang.advanceType !== "anzahlung" && leistungstag(anfang) >= STEUERFREI_AB;
}

/** Die Umsätze als Kleinunternehmer im Zeitraum, je Rechnung mit dem Entgelt der Leistung */
export async function kleinunternehmerUmsaetze(period: VatPeriod, q: Db | Tx): Promise<RevenueSource[]> {
  const { start, end } = periodRange(period);
  const i = schema.invoices;
  const imZeitraum = (spalte: typeof i.issueDate | typeof i.serviceDate) => and(gte(spalte, start), lt(spalte, end));
  const kandidaten = await q
    .select()
    .from(i)
    .where(
      and(
        eq(i.status, "final"),
        eq(i.taxTreatment, "kleinunternehmer"),
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
  const totals = await invoiceTotalsById(
    zaehlen.map((r) => r.id),
    q,
  );
  // Die Schlussrechnung zieht Abschläge als eigene Positionen ab; abgezogene Anzahlungen gehören zum Entgelt der Leistung,
  // abgezogene Teilleistungen nicht (sie zählen im Monat ihrer eigenen Leistung)
  const abzuege = await anzahlungsAbzuege(
    zaehlen.map((r) => r.id),
    q,
  );
  return zaehlen.map((r) => ({
    type: "invoice",
    date: leistungstag(r),
    invoiceId: r.id,
    number: r.number ?? "",
    customer: r.buyer?.name ?? "",
    treatment: "kleinunternehmer",
    rate: 0,
    base: (totals.get(r.id)?.net ?? 0) - (abzuege.get(r.id) ?? 0),
    tax: 0,
  }));
}

/** Skonto und Forderungsausfall auf Rechnungen als Kleinunternehmer im Zeitraum, samt Aufhebung (mit umgekehrtem Vorzeichen) */
async function ausbuchungen(period: VatPeriod, q: Db | Tx): Promise<RevenueSource[]> {
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
        eq(i.taxTreatment, "kleinunternehmer"),
        isNull(i.lexofficeVoucherId),
      ),
    );
  const taxes = invoiceTaxReader(q);
  const result: RevenueSource[] = [];
  for (const { date, amount, rechnung } of rows) {
    // Was nicht in Kz 48 steht (Anzahlung, Leistung vor 2025), mindert ihre Ausbuchung auch nicht
    if (!(await zaehlt(rechnung, taxes))) continue;
    result.push({
      type: "ausbuchung",
      date,
      invoiceId: rechnung.id,
      number: rechnung.number ?? "",
      customer: rechnung.buyer?.name ?? "",
      treatment: "kleinunternehmer",
      rate: 0,
      base: -amount,
      tax: 0,
    });
  }
  return result;
}

/**
 * Bis zur Rückzahlung gehaltene Minderungen schon bezahlter Rechnungen (kleinunternehmerBisZurRueckzahlung): im Monat von
 * Storno oder Korrektur als Gegenbetrag, mit der Rückzahlung als Minderung. Nur Ketten mit einem Storno oder einer Korrektur
 * vor dem Ende des Zeitraums, vorher hält nichts.
 */
async function bisZurRueckzahlung(period: VatPeriod, q: Db | Tx): Promise<RevenueSource[]> {
  const { start, end } = periodRange(period);
  const anfaenge = await q.execute<{ id: string }>(sql`with recursive up(id, parent) as (
    select id, corrects_id from invoices
      where reduction_rule is not null and status = 'final' and tax_treatment = 'kleinunternehmer' and issue_date < ${end}
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
        eq(i.taxTreatment, "kleinunternehmer"),
        isNull(i.lexofficeVoucherId),
      ),
    );
  const taxes = invoiceTaxReader(q);
  const result: RevenueSource[] = [];
  for (const r of rechnungen) {
    if (!(await zaehlt(r, taxes))) continue;
    for (const { date, shares } of await kleinunternehmerBisZurRueckzahlung(r, q))
      if (date >= start && date < end)
        result.push({
          type: "invoice",
          date,
          invoiceId: r.id,
          number: r.number ?? "",
          customer: r.buyer?.name ?? "",
          treatment: "kleinunternehmer",
          rate: 0,
          base: shares.reduce((s, x) => s + x.base, 0),
          tax: 0,
        });
  }
  return result;
}

/** Je Rechnung die Summe ihrer Abzugspositionen für Anzahlungen (negativ) */
async function anzahlungsAbzuege(ids: string[], q: Db | Tx): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const l = schema.invoiceLines;
  const abschlag = schema.invoices;
  const rows = await q
    .select({ invoiceId: l.invoiceId, net: l.net })
    .from(l)
    .innerJoin(abschlag, eq(abschlag.id, l.deductionOf))
    .where(and(inArray(l.invoiceId, ids), ne(abschlag.advanceType, "teilleistung")));
  const summe = new Map<string, number>();
  for (const r of rows) summe.set(r.invoiceId, (summe.get(r.invoiceId) ?? 0) + r.net);
  return summe;
}

/**
 * Die Kennzahlen der Voranmeldung: aus dem Journal (#542, #1116), wie bei DATEV aus Konto und Steuerschlüssel; dazu die
 * Privatnutzung von Fahrzeugen je Monat aus dem Anlagenverzeichnis (das Journal bucht sie erst mit der AfA) und die Umsätze
 * als Kleinunternehmer in Kz 48, die das Journal ohne Kennzahl trägt (#1268)
 */
export async function kennzahlenDerVoranmeldung(
  period: VatPeriod,
  versteuerung: Versteuerung,
  revenue: readonly RevenueSource[],
  q: Db | Tx,
): Promise<JournalKennzahlen & { kz48Kleinunternehmer: number; kleinunternehmerUmsaetze: RevenueSource[] }> {
  const kennzahlen = await kennzahlenAusDemJournal(period, versteuerung, q);
  const entnahme = revenue.filter((r) => r.type === "entnahme");
  kennzahlen.kz81 += entnahme.reduce((s, r) => s + r.base, 0);
  kennzahlen.tax81 += entnahme.reduce((s, r) => s + r.tax, 0);
  const ohneRechnung = revenue.filter((r) => (r.type === "kasse" || r.type === "direkt") && r.treatment === "kleinunternehmer");
  const kleinunternehmer =
    periodRange(period).start < STEUERFREI_AB
      ? []
      : [...ohneRechnung, ...(await kleinunternehmerUmsaetze(period, q)), ...(await ausbuchungen(period, q)), ...(await bisZurRueckzahlung(period, q))];
  const kz48Kleinunternehmer = kleinunternehmer.reduce((s, r) => s + r.base, 0);
  return { ...kennzahlen, kz48: kennzahlen.kz48 + kz48Kleinunternehmer, kz48Kleinunternehmer, kleinunternehmerUmsaetze: kleinunternehmer };
}
