import { periodRange, type Cents, type JournalKennzahlen, type TaxTreatment, type VatPeriod, type Versteuerung } from "@haben/core";
import { and, eq, gte, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { schema, type Db, type Tx } from "../../db/index.ts";
import { invoiceTaxReader, invoiceTotalsById } from "../rechnungen/index.ts";
import type { RevenueSource } from "./vat-figures.ts";
import { kennzahlenAusDemJournal } from "./vat-journal.ts";

/*
 * Steuerfreie Umsätze im Zeitraum der Leistung, auch bei Ist-Versteuerung: Kz 48 (§ 4 Nr. 8 bis 29 und § 19 Abs. 1 UStG)
 * und Kz 43 (Ausfuhr). Die Anleitung zur UStVA 2026 sagt unter beiden Kennzahlen: „Anzahlungen zu steuerfreien Umsätzen
 * tragen Sie bitte nicht ein. Den Gesamtbetrag (Anzahlungen und Restzahlung) geben Sie bitte im Voranmeldungszeitraum der
 * Leistungsausführung an.“ Eine Ausnahme für die Ist-Versteuerung nennt sie nicht
 * (https://www.elster.de/eportal/helpGlobal?themaGlobal=help_ustva_2026#kz48 und #kz43). Die Summe kommt aus den
 * Rechnungen nach dem Leistungstag wie bei der Soll-Versteuerung: eingefroren beim Festschreiben, sonst Leistung bis,
 * Leistung von, Rechnungsdatum; Anzahlungen zählen nicht, die Schlussrechnung mit den abgezogenen Anzahlungen. Storno und
 * Korrektur zählen im Monat ihres Datums (§ 17 UStG), ebenso Skonto und Forderungsausfall im Monat der Ausbuchung bzw.
 * ihrer Aufhebung: Die Anleitung verlangt unter „Allgemein“, Entgeltminderungen bei den Bemessungsgrundlagen zu
 * berücksichtigen. Bareinnahmen und direkt gebuchte Erlöse ohne Rechnung zählen am Tag der Zahlung: Ohne Rechnung kennt
 * Haben keinen anderen Tag (bareinnahme.ts, direkt-kategorie.ts in @haben/core).
 *
 * Umsätze als Kleinunternehmer (#1268): Das Journal trägt sie mit dem Steuerschlüssel „KU“, der in keine Kennzahl führt;
 * die Summe kommt bei Ist und Soll aus Rechnungen, Bareinnahmen und Direktbuchungen. Erst ab 2025: Vorher war ein Umsatz
 * nach § 19 Abs. 1 nicht steuerfrei, Kz 48 der UStVA 2024 nennt nur § 4 Nr. 8 bis 29, die der UStVA 2025 auch § 19 Abs. 1
 * (ERiC 44.3.6.0, UStVA-2024.xsd und UStVA-2025.xsd, Element Kz48). Storno, Korrektur und Ausbuchung eines Umsatzes von
 * 2024 mindern Kz 48 deshalb auch 2025 nicht.
 *
 * § 4 UStG und Ausfuhr (#1312): Das Journal bucht sie wie DATEV bei Soll nach dem Leistungstag und bei Ist mit der Zahlung
 * (IST_NACH_ZAHLUNG in @haben/core). Soll bleibt beim Journal. Bei Ist rechnet die Voranmeldung den Teil an Zahlungen heraus
 * (bemessungAnZahlungen) und nimmt die Rechnungen im Ist-Verfahren nach dem Leistungstag. Aus Lexoffice übernommene
 * Rechnungen behalten die Zahlung: Bei Ist hatte Lexoffice sie noch nicht gemeldet (umsatzsteuer.md, Übernahmen aus Lexoffice).
 */

const STEUERFREI_AB = "2025-01-01";
/** § 4 UStG (Kz 48) und Ausfuhr (Kz 43): bei Ist nach dem Leistungstag statt mit der Zahlung */
const BEI_IST_NACH_LEISTUNG = ["steuerfrei", "ausfuhr"] as const satisfies readonly TaxTreatment[];
const beiIstNachLeistung = (t: TaxTreatment) => BEI_IST_NACH_LEISTUNG.some((b) => b === t);

type Rechnung = typeof schema.invoices.$inferSelect;
type Daten = Pick<Rechnung, "issueDate"> & Partial<Pick<Rechnung, "kind" | "serviceDate" | "serviceTo" | "serviceFrom">>;
type Taxes = ReturnType<typeof invoiceTaxReader>;
/** Ob ein Beleg der Behandlung im Zeitraum der Leistung zählt */
type Zaehlt = (r: Rechnung, taxes: Taxes) => Promise<boolean>;

const leistungstag = (r: Daten) => (r.kind === "rechnung" ? (r.serviceDate ?? r.serviceTo ?? r.serviceFrom ?? r.issueDate) : r.issueDate);
const summe = (quellen: readonly RevenueSource[]) => quellen.reduce((s, r) => s + r.base, 0);

/**
 * Kleinunternehmer: Entscheidend ist der Anfang der Kette. Anzahlungen zählen nicht, auch nicht ihr Storno, ihre Korrektur
 * und deren Storno, das auf die Korrektur verweist (cancelInvoice), und Leistungen vor 2025 nicht
 */
const kleinunternehmerZaehlt: Zaehlt = async (r, taxes) => {
  const anfang = await taxes.original(r);
  return anfang.advanceType !== "anzahlung" && leistungstag(anfang) >= STEUERFREI_AB;
};

/**
 * § 4 und Ausfuhr bei Ist: keine Anzahlung am Anfang der Kette, Steuerjahr im Ist-Verfahren und ein Beleg mit eigener
 * Buchung (Papierstorno und Ersatz einer Schlussrechnung im Bilanzverfahren buchen nichts, #750)
 */
const beiIstZaehlt: Zaehlt = async (r, taxes) => {
  const anfang = await taxes.original(r);
  return anfang.advanceType !== "anzahlung" && (await taxes.companyMode(anfang)) === "ist" && (await taxes.invoicePostingAllowed(r));
};

/** Rechnungen, Stornos und Korrekturen der Behandlungen mit Leistung im Zeitraum, je Beleg mit dem Entgelt der Leistung */
async function rechnungenNachLeistung(period: VatPeriod, behandlungen: readonly TaxTreatment[], zaehlt: Zaehlt, q: Db | Tx): Promise<RevenueSource[]> {
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
async function ausbuchungenNachLeistung(period: VatPeriod, behandlungen: readonly TaxTreatment[], zaehlt: Zaehlt, q: Db | Tx): Promise<RevenueSource[]> {
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
async function anzahlungsAbzuege(ids: string[], q: Db | Tx): Promise<Map<string, number>> {
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

/** Die Umsätze als Kleinunternehmer im Zeitraum: Rechnungen, Ausbuchungen, Bareinnahmen und Direktbuchungen */
async function kleinunternehmerUmsaetze(period: VatPeriod, revenue: readonly RevenueSource[], q: Db | Tx): Promise<RevenueSource[]> {
  if (periodRange(period).start < STEUERFREI_AB) return [];
  const ohneRechnung = revenue.filter((r) => (r.type === "kasse" || r.type === "direkt") && r.treatment === "kleinunternehmer");
  return [
    ...ohneRechnung,
    ...(await rechnungenNachLeistung(period, ["kleinunternehmer"], kleinunternehmerZaehlt, q)),
    ...(await ausbuchungenNachLeistung(period, ["kleinunternehmer"], kleinunternehmerZaehlt, q)),
  ];
}

/**
 * Bei Ist die Quellen von § 4 und Ausfuhr nach dem Leistungstag: Zahlungen und Steuerpläne von Anzahlungen fallen weg, an
 * ihre Stelle treten Rechnungen und Ausbuchungen; Zahlungen auf aus Lexoffice übernommene Rechnungen bleiben.
 */
async function steuerfreiBeiIst(period: VatPeriod, revenue: readonly RevenueSource[], q: Db | Tx) {
  const ids = [...new Set(revenue.filter((r) => beiIstNachLeistung(r.treatment) && r.invoiceId !== "").map((r) => r.invoiceId))];
  const i = schema.invoices;
  const rechnungen = ids.length
    ? await q.select({ id: i.id, lexofficeVoucherId: i.lexofficeVoucherId, advanceType: i.advanceType }).from(i).where(inArray(i.id, ids))
    : [];
  const lexoffice = new Set(rechnungen.filter((r) => r.lexofficeVoucherId !== null).map((r) => r.id));
  const anzahlung = new Set(rechnungen.filter((r) => r.advanceType === "anzahlung").map((r) => r.id));
  const weg = (r: RevenueSource) =>
    beiIstNachLeistung(r.treatment) && ((r.type === "payment" && !lexoffice.has(r.invoiceId)) || (r.type === "invoice" && anzahlung.has(r.invoiceId)));
  const neu = [
    ...(await rechnungenNachLeistung(period, BEI_IST_NACH_LEISTUNG, beiIstZaehlt, q)),
    ...(await ausbuchungenNachLeistung(period, BEI_IST_NACH_LEISTUNG, beiIstZaehlt, q)),
  ];
  const lexofficeZahlungen = revenue.filter((r) => r.type === "payment" && lexoffice.has(r.invoiceId) && beiIstNachLeistung(r.treatment));
  return { revenue: [...revenue.filter((r) => !weg(r)), ...neu], zusaetzlich: [...neu, ...lexofficeZahlungen] };
}

/**
 * Die Kennzahlen der Voranmeldung: aus dem Journal (#542, #1116), wie bei DATEV aus Konto und Steuerschlüssel; dazu die
 * Privatnutzung von Fahrzeugen je Monat aus dem Anlagenverzeichnis (das Journal bucht sie erst mit der AfA), die Umsätze
 * als Kleinunternehmer in Kz 48, die das Journal ohne Kennzahl trägt (#1268), und bei Ist Kz 43 und 48 nach dem
 * Leistungstag statt mit der Zahlung (#1312). `revenue` sind die Quellen unter den Kennzahlen, bei Ist mit den Rechnungen
 * statt der Zahlungen für § 4 und Ausfuhr. `nachZahlungseingang`: Kz 43 und 48, wie Haben sie vor #1312 und #1268 gemeldet
 * hat (bei Ist mit der Zahlung, ohne Umsätze als Kleinunternehmer), für den Abgleich gesendeter Voranmeldungen.
 */
export async function kennzahlenDerVoranmeldung(
  period: VatPeriod,
  versteuerung: Versteuerung,
  revenue: readonly RevenueSource[],
  q: Db | Tx,
): Promise<
  JournalKennzahlen & {
    kz48Kleinunternehmer: Cents;
    kleinunternehmerUmsaetze: RevenueSource[];
    nachZahlungseingang: { kz43: Cents; kz48: Cents };
    revenue: RevenueSource[];
  }
> {
  const { kennzahlen, anZahlungen } = await kennzahlenAusDemJournal(period, versteuerung, q);
  const entnahme = revenue.filter((r) => r.type === "entnahme");
  kennzahlen.kz81 += summe(entnahme);
  kennzahlen.tax81 += entnahme.reduce((s, r) => s + r.tax, 0);
  const nachZahlungseingang = { kz43: kennzahlen.kz43, kz48: kennzahlen.kz48 };
  let quellen = [...revenue];
  if (versteuerung === "ist") {
    const beiIst = await steuerfreiBeiIst(period, revenue, q);
    quellen = beiIst.revenue;
    kennzahlen.kz43 += summe(beiIst.zusaetzlich.filter((r) => r.treatment === "ausfuhr")) - anZahlungen.kz43;
    kennzahlen.kz48 += summe(beiIst.zusaetzlich.filter((r) => r.treatment === "steuerfrei")) - anZahlungen.kz48;
  }
  const kleinunternehmer = await kleinunternehmerUmsaetze(period, revenue, q);
  const kz48Kleinunternehmer = summe(kleinunternehmer);
  return {
    ...kennzahlen,
    kz48: kennzahlen.kz48 + kz48Kleinunternehmer,
    kz48Kleinunternehmer,
    kleinunternehmerUmsaetze: kleinunternehmer,
    nachZahlungseingang,
    revenue: quellen,
  };
}
