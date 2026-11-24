import { periodRange, type Cents, type TaxTreatment, type VatPeriod, type Versteuerung } from "@haben/core";
import { and, eq, gte, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { schema, type Db, type Tx } from "../../db/index.ts";
import { anzahlungsAbzuege, steuerfreiBisZurRueckzahlung, invoiceTaxReader } from "../rechnungen/index.ts";
import { ausbuchungenNachLeistung, rechnungenNachLeistung, summe, type Zaehlt } from "./leistung-belege.ts";
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
 *   Leistungstag (leistung-belege.ts). Storno und Korrektur einer bezahlten Rechnung mindern wie bei Soll erst mit der
 *   Rückzahlung (#1228, steuerfreiBisZurRueckzahlung): UStAE 17.1 Abs. 2 Satz 3, „mindert sich die Bemessungsgrundlage nur, soweit das
 *   Entgelt tatsächlich zurückgezahlt wird, und zwar in dem Besteuerungszeitraum, in dem die Rückgewähr erfolgt“; die
 *   Anleitung sagt nur, die Berichtigung gehöre „in dem Voranmeldungszeitraum vor, in dem die Änderung der
 *   Bemessungsgrundlage eingetreten ist“ (§ 17 Abs. 1 Satz 8 UStG), also nichts anderes. Aus Lexoffice übernommene
 *   Rechnungen behalten die Zahlung: Bei Ist hatte das Quellprogramm sie noch nicht gemeldet (umsatzsteuer.md).
 */

const STEUERFREI = ["steuerfrei", "ausfuhr"] as const satisfies readonly TaxTreatment[];
const steuerfrei = (t: TaxTreatment) => STEUERFREI.some((b) => b === t);

/** Kz 43 und 48 eines Teils der Buchungen bzw. Quellen */
type Teil = { kz43: Cents; kz48: Cents };
const teil = (quellen: readonly RevenueSource[]): Teil => ({
  kz43: summe(quellen.filter((r) => r.treatment === "ausfuhr")),
  kz48: summe(quellen.filter((r) => r.treatment === "steuerfrei")),
});

/**
 * Bei Ist: keine Anzahlung am Anfang der Kette, Steuerjahr im Ist-Verfahren und ein Beleg mit eigener Buchung
 * (Papierstorno und Ersatz einer Schlussrechnung im Bilanzverfahren buchen nichts, #750)
 */
const beiIstZaehlt: Zaehlt = async (r, taxes) => {
  const anfang = await taxes.original(r);
  return anfang.advanceType !== "anzahlung" && (await taxes.companyMode(anfang)) === "ist" && (await taxes.invoicePostingAllowed(r));
};

/** Bei Ist: bis zur Rückzahlung gehaltene Bemessungsgrundlage nach Storno oder Korrektur einer bezahlten Rechnung */
async function gehaltenBeiIst(period: VatPeriod, q: Db | Tx): Promise<RevenueSource[]> {
  const { start, end } = periodRange(period);
  const i = schema.invoices;
  const korrekturen = await q
    .select()
    .from(i)
    .where(
      and(eq(i.status, "final"), isNotNull(i.reductionRule), inArray(i.taxTreatment, [...STEUERFREI]), isNull(i.lexofficeVoucherId), lt(i.issueDate, end)),
    );
  if (korrekturen.length === 0) return [];
  const taxes = invoiceTaxReader(q);
  const ids = new Set<string>();
  for (const k of korrekturen) {
    const anfang = await taxes.original(k);
    if (anfang.id && anfang.advanceType !== "anzahlung" && (await taxes.companyMode(anfang)) === "ist") ids.add(anfang.id);
  }
  if (ids.size === 0) return [];
  const originale = await q
    .select()
    .from(i)
    .where(inArray(i.id, [...ids]));
  const result: RevenueSource[] = [];
  for (const o of originale)
    for (const change of await steuerfreiBisZurRueckzahlung(o, q, taxes)) {
      if (change.date < start || change.date >= end) continue;
      for (const share of change.shares)
        result.push({
          type: "invoice",
          date: change.date,
          invoiceId: o.id,
          number: o.number ?? "",
          customer: o.buyer?.name ?? "",
          treatment: o.taxTreatment,
          exemptionReason: o.exemptionReason,
          rate: share.rate,
          base: share.base,
          tax: 0,
        });
    }
  return result;
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

/**
 * Kz 43 und 48 im Zeitraum der Leistung: was zum Journal dazukommt (`dazu`), was aus ihm herausfällt (`heraus`, aus
 * kennzahlenAusDemJournal) und die Quellen unter den Kennzahlen. Bei Soll fallen die Buchungen steuerfreier Anzahlungen
 * heraus, bei Ist die Zahlungen; ihre Quellen ebenso, außer Zahlungen auf übernommene Rechnungen. Belege eines Jahres nach
 * Ist zählen auch in einem späteren Jahr nach Soll wie bei Ist (Storno, Ausbuchung, gehaltene Beträge), ihre Zahlungen
 * dort nicht: Die Leistung steht schon im Ist-Jahr (Wechsel zum Jahreswechsel, Rechnung im neuen Jahr).
 */
export async function steuerfreiNachLeistung(
  period: VatPeriod,
  versteuerung: Versteuerung,
  journal: { zahlungsanteil: Teil; anzahlungsanteil: Teil },
  revenue: readonly RevenueSource[],
  q: Db | Tx,
): Promise<{ kz43: Cents; kz48: Cents; revenue: RevenueSource[] }> {
  const ids = [...new Set(revenue.filter((r) => steuerfrei(r.treatment) && r.invoiceId !== "").map((r) => r.invoiceId))];
  const i = schema.invoices;
  const rechnungen = ids.length
    ? await q.select({ id: i.id, lexofficeVoucherId: i.lexofficeVoucherId, advanceType: i.advanceType }).from(i).where(inArray(i.id, ids))
    : [];
  const lexoffice = new Set(rechnungen.filter((r) => r.lexofficeVoucherId !== null).map((r) => r.id));
  const anzahlung = new Set(rechnungen.filter((r) => r.advanceType === "anzahlung").map((r) => r.id));
  const ist = versteuerung === "ist";
  // Zahlungen stehen unter den Quellen nur für Rechnungen eines Jahres nach Ist (vat-figures.ts), bei Soll also nur nach einem Wechsel
  const zahlung = (r: RevenueSource) => r.type === "payment" && steuerfrei(r.treatment) && !lexoffice.has(r.invoiceId);
  // Steuerplan einer Anzahlung (bei Soll und Ist) und die Zahlungen auf Rechnungen
  const weg = (r: RevenueSource) => zahlung(r) || (steuerfrei(r.treatment) && r.type === "invoice" && anzahlung.has(r.invoiceId));
  // beiIstZaehlt nimmt nur Belege, deren Kette in einem Jahr nach Ist beginnt
  const neu = [
    ...(await rechnungenNachLeistung(period, STEUERFREI, beiIstZaehlt, q)),
    ...(await ausbuchungenNachLeistung(period, STEUERFREI, beiIstZaehlt, q)),
    ...(await gehaltenBeiIst(period, q)),
    ...(ist ? [] : await anzahlungenDerSchlussrechnungBeiSoll(period, q)),
  ];
  // Bei Soll trägt das Journal die Zahlungen eines Ist-Jahres mit ihrer Bemessungsgrundlage wie die Quellen
  const zahlungen = teil(revenue.filter(zahlung));
  const heraus = ist ? journal.zahlungsanteil : { kz43: journal.anzahlungsanteil.kz43 + zahlungen.kz43, kz48: journal.anzahlungsanteil.kz48 + zahlungen.kz48 };
  // Zahlungen auf übernommene Rechnungen stehen im Zahlungsanteil des Journals und bleiben
  const dazu = teil([...neu, ...(ist ? revenue.filter((r) => r.type === "payment" && lexoffice.has(r.invoiceId) && steuerfrei(r.treatment)) : [])]);
  return { kz43: dazu.kz43 - heraus.kz43, kz48: dazu.kz48 - heraus.kz48, revenue: [...revenue.filter((r) => !weg(r)), ...neu] };
}
