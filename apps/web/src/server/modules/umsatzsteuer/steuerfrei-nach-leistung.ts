import { periodRange, type Cents, type TaxTreatment, type VatPeriod, type Versteuerung } from "@haben/core";
import { and, eq, gte, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { schema, type Db, type Tx } from "../../db/index.ts";
import { anzahlungenBisZurRueckzahlung, anzahlungsAbzuege, invoiceTaxReader, nachLeistungBisZurRueckzahlung } from "../rechnungen/index.ts";
import { ausbuchungenNachLeistung, gehalteneMinderungen, rechnungenNachLeistung, summe, type Taxes, type Zaehlt } from "./leistung-belege.ts";
import type { RevenueSource } from "./vat-figures.ts";

/*
 * § 4 UStG (Kz 48) und Ausfuhr (Kz 43) im Zeitraum der Leistung, bei Ist und Soll (#1312). Anleitung zur UStVA 2026 unter
 * beiden Kennzahlen: „Anzahlungen zu steuerfreien Umsätzen tragen Sie bitte nicht ein. Den Gesamtbetrag (Anzahlungen und
 * Restzahlung) geben Sie bitte im Voranmeldungszeitraum der Leistungsausführung an.“ Eine Ausnahme für die
 * Ist-Versteuerung nennt sie nicht (https://www.elster.de/eportal/helpGlobal?themaGlobal=help_ustva_2026#kz48, #kz43).
 *
 * Das Journal bucht diese Umsätze wie DATEV, bei Soll nach dem Leistungstag, bei Ist mit der Zahlung (IST_NACH_ZAHLUNG in
 * @haben/core), Anzahlungen in beiden Fällen mit der Zahlung (Steuerplan, § 13 Abs. 1 Nr. 1 Buchst. a Satz 4 UStG).
 * - Soll: Kz 43 und 48 ohne die Buchungen steuerfreier Anzahlungen; die Schlussrechnung zählt zuzüglich der abgezogenen
 *   Anzahlungen, an ihrem Tag.
 * - Ist: Kz 43 und 48 ohne die Bemessungsgrundlage an Zahlungen (bemessungAnZahlungen); dafür die Rechnungen nach dem
 *   Leistungstag (leistung-belege.ts).
 * - Storno und Korrektur einer bezahlten Rechnung mindern erst mit der Rückzahlung, auch die bezahlte Anzahlung einer
 *   Schlussrechnung (rechnungen/rueckzahlung-nach-leistung.ts, dieselbe Regel wie als Kleinunternehmer).
 *
 * Übergang wie bei #1228: Das gilt nur für Ketten, deren Rechnung das Kennzeichen exempt_rule trägt (beim Festschreiben
 * gesetzt). Vorher festgeschriebene Ketten zählen samt Zahlungen und Anzahlungen weiter wie gebucht; so ändert sich keine
 * gesendete Voranmeldung, und kein Umsatz fehlt in allen (Entscheidung in #1771). Aus Lexoffice übernommene Rechnungen
 * tragen kein Kennzeichen: Bei Ist hatte das Quellprogramm sie noch nicht gemeldet, die Zahlung zählt (umsatzsteuer.md).
 */

const STEUERFREI = ["steuerfrei", "ausfuhr"] as const satisfies readonly TaxTreatment[];
const steuerfrei = (t: TaxTreatment) => STEUERFREI.some((b) => b === t);

/** Kz 43 und 48 eines Teils der Buchungen bzw. Quellen */
type Teil = { kz43: Cents; kz48: Cents };
const teil = (quellen: readonly RevenueSource[]): Teil => ({
  kz43: summe(quellen.filter((r) => r.treatment === "ausfuhr")),
  kz48: summe(quellen.filter((r) => r.treatment === "steuerfrei")),
});

/** Nach dem Leistungstag zählende Kette ohne Anzahlung am Anfang */
async function neueLeistung(r: Parameters<Zaehlt>[0], taxes: Taxes) {
  const anfang = await taxes.original(r);
  return anfang.exemptRule === "leistung" && anfang.advanceType !== "anzahlung" ? anfang : null;
}

/**
 * Bei Ist: dazu Steuerjahr im Ist-Verfahren und ein Beleg mit eigener Buchung (Papierstorno und Ersatz einer
 * Schlussrechnung im Bilanzverfahren buchen nichts, #750)
 */
const beiIstZaehlt: Zaehlt = async (r, taxes) => {
  const anfang = await neueLeistung(r, taxes);
  return anfang !== null && (await taxes.companyMode(anfang)) === "ist" && (await taxes.invoicePostingAllowed(r));
};

/** Gehaltene Minderungen: bei Ist alle, bei Soll nur die der abgezogenen Anzahlungen, den Rest bucht das Journal */
async function gehalten(period: VatPeriod, q: Db | Tx): Promise<RevenueSource[]> {
  const zaehlt: Zaehlt = async (r, taxes) => (await neueLeistung(r, taxes)) !== null;
  return gehalteneMinderungen(
    period,
    STEUERFREI,
    zaehlt,
    async (r, taxes) => ((await taxes.companyMode(r)) === "ist" ? nachLeistungBisZurRueckzahlung(r, q, taxes) : anzahlungenBisZurRueckzahlung(r, q, taxes)),
    q,
  );
}

/** Bei Soll: die abgezogenen Anzahlungen einer Schlussrechnung (und ihres Stornos) an deren Tag in der Voranmeldung */
async function anzahlungenDerSchlussrechnungBeiSoll(period: VatPeriod, q: Db | Tx): Promise<RevenueSource[]> {
  const { start, end } = periodRange(period);
  const i = schema.invoices;
  const l = schema.invoiceLines;
  const imZeitraum = (spalte: typeof i.issueDate | typeof i.serviceDate) => and(gte(spalte, start), lt(spalte, end));
  const kandidaten = await q
    .selectDistinct({ rechnung: i })
    .from(i)
    .innerJoin(l, eq(l.invoiceId, i.id))
    .where(
      and(
        eq(i.status, "final"),
        inArray(i.taxTreatment, [...STEUERFREI]),
        isNull(i.lexofficeVoucherId),
        isNotNull(l.deductionOf),
        or(imZeitraum(i.issueDate), imZeitraum(i.serviceDate)),
      ),
    );
  if (kandidaten.length === 0) return [];
  const taxes = invoiceTaxReader(q);
  // Nur Anzahlungen mit Kennzeichen (anzahlungZurLeistung); ältere stehen mit ihrer Zahlung im Journal
  const abzuege = await anzahlungsAbzuege(
    kandidaten.map((k) => k.rechnung.id),
    q,
  );
  const result: RevenueSource[] = [];
  for (const { rechnung: r } of kandidaten) {
    const abzug = abzuege.get(r.id) ?? 0;
    if (abzug === 0 || (await taxes.companyMode(await taxes.original(r))) !== "soll" || !(await taxes.invoicePostingAllowed(r))) continue;
    // Derselbe Tag wie die Buchung der Schlussrechnung (invoiceVatDate), beim Storno sein Datum
    const date = r.kind === "rechnung" ? await taxes.date(r) : r.issueDate;
    if (date < start || date >= end) continue;
    result.push({
      type: "invoice",
      date,
      invoiceId: r.id,
      number: r.number ?? "",
      customer: r.buyer?.name ?? "",
      treatment: r.taxTreatment,
      exemptionReason: r.exemptionReason,
      rate: 0,
      base: -abzug,
      tax: 0,
    });
  }
  return result;
}

/** Je Rechnung unter den Quellen: zählt ihre Kette nach dem Leistungstag, und ist sie eine Anzahlung? */
async function kettenNachLeistung(revenue: readonly RevenueSource[], q: Db | Tx): Promise<Map<string, { anzahlung: boolean }>> {
  const ids = [...new Set(revenue.filter((r) => steuerfrei(r.treatment) && r.invoiceId !== "").map((r) => r.invoiceId))];
  if (ids.length === 0) return new Map();
  const i = schema.invoices;
  const rechnungen = await q.select({ id: i.id, issueDate: i.issueDate, correctsId: i.correctsId }).from(i).where(inArray(i.id, ids));
  const taxes = invoiceTaxReader(q);
  const result = new Map<string, { anzahlung: boolean }>();
  for (const r of rechnungen) {
    const anfang = await taxes.original(r);
    if (anfang.exemptRule === "leistung") result.set(r.id, { anzahlung: anfang.advanceType === "anzahlung" });
  }
  return result;
}

/**
 * Kz 43 und 48 im Zeitraum der Leistung: was zum Journal dazukommt (`dazu`), was aus ihm herausfällt (`heraus`, aus
 * kennzahlenAusDemJournal, nur Ketten mit Kennzeichen) und die Quellen unter den Kennzahlen. Bei Soll fallen die Buchungen
 * steuerfreier Anzahlungen heraus, bei Ist die Zahlungen; ihre Quellen ebenso. Belege eines Jahres nach Ist zählen auch in
 * einem späteren Jahr nach Soll wie bei Ist (Storno, Ausbuchung, gehaltene Beträge), ihre Zahlungen dort nicht: Die
 * Leistung steht schon im Ist-Jahr (Wechsel zum Jahreswechsel, Rechnung im neuen Jahr).
 */
export async function steuerfreiNachLeistung(
  period: VatPeriod,
  versteuerung: Versteuerung,
  journal: { zahlungsanteil: Teil; anzahlungsanteil: Teil },
  revenue: readonly RevenueSource[],
  q: Db | Tx,
): Promise<{ kz43: Cents; kz48: Cents; revenue: RevenueSource[] }> {
  const ketten = await kettenNachLeistung(revenue, q);
  const ist = versteuerung === "ist";
  // Zahlungen stehen unter den Quellen nur für Rechnungen eines Jahres nach Ist (vat-figures.ts), bei Soll also nur nach einem Wechsel
  const zahlung = (r: RevenueSource) => r.type === "payment" && steuerfrei(r.treatment) && ketten.has(r.invoiceId);
  // Steuerplan einer Anzahlung (bei Soll und Ist) und die Zahlungen auf Rechnungen
  const weg = (r: RevenueSource) => zahlung(r) || (steuerfrei(r.treatment) && r.type === "invoice" && ketten.get(r.invoiceId)?.anzahlung === true);
  // beiIstZaehlt nimmt nur Belege, deren Kette in einem Jahr nach Ist beginnt
  const neu = [
    ...(await rechnungenNachLeistung(period, STEUERFREI, beiIstZaehlt, q)),
    ...(await ausbuchungenNachLeistung(period, STEUERFREI, beiIstZaehlt, q)),
    ...(await gehalten(period, q)),
    ...(ist ? [] : await anzahlungenDerSchlussrechnungBeiSoll(period, q)),
  ];
  // Bei Soll trägt das Journal die Zahlungen eines Ist-Jahres mit ihrer Bemessungsgrundlage wie die Quellen
  const zahlungen = teil(revenue.filter(zahlung));
  const heraus = ist ? journal.zahlungsanteil : { kz43: journal.anzahlungsanteil.kz43 + zahlungen.kz43, kz48: journal.anzahlungsanteil.kz48 + zahlungen.kz48 };
  const dazu = teil(neu);
  return { kz43: dazu.kz43 - heraus.kz43, kz48: dazu.kz48 - heraus.kz48, revenue: [...revenue.filter((r) => !weg(r)), ...neu] };
}
