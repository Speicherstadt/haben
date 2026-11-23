import { periodRange, type JournalKennzahlen, type VatPeriod, type Versteuerung } from "@haben/core";
import { and, eq, gte, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { schema, type Db, type Tx } from "../../db/index.ts";
import { invoiceTotalsById } from "../rechnungen/index.ts";
import type { RevenueSource } from "./vat-figures.ts";
import { kennzahlenAusDemJournal } from "./vat-journal.ts";

/*
 * Umsätze als Kleinunternehmer in Kz 48 (#1268). Die Anleitung zur UStVA 2026 nennt unter Kz 48 die Umsätze nach § 19
 * Abs. 1 UStG (seit 2025 steuerfrei) und ordnet den Gesamtbetrag einschließlich Anzahlung und Restzahlung dem
 * Voranmeldungszeitraum der Leistungsausführung zu; Anzahlungen selbst meldet man nicht, eine Ausnahme für die
 * Ist-Versteuerung gibt es nicht (https://www.elster.de/eportal/helpGlobal?themaGlobal=help_ustva_2026#kz48). Das Journal
 * trägt diese Erlöse mit dem Steuerschlüssel „KU“, der in keine Kennzahl führt, bei Ist erst mit der Zahlung; die Summe
 * kommt deshalb aus den Rechnungen, bei Ist und Soll nach dem Leistungstag wie bei der Soll-Versteuerung: eingefroren beim
 * Festschreiben, sonst Leistung bis, Leistung von, Rechnungsdatum. Storno und Korrektur zählen im Monat ihres Datums
 * (§ 17 UStG). Bareinnahmen und direkt gebuchte Erlöse ohne Rechnung zählen am Tag der Zahlung: Ohne Rechnung kennt Haben
 * keinen anderen Tag (bareinnahme.ts, direkt-kategorie.ts in @haben/core).
 */

type Rechnung = typeof schema.invoices.$inferSelect;

const leistungstag = (r: Rechnung) => (r.kind === "rechnung" ? (r.serviceDate ?? r.serviceTo ?? r.serviceFrom ?? r.issueDate) : r.issueDate);

/** Die Umsätze als Kleinunternehmer im Zeitraum, je Rechnung mit dem Entgelt der Leistung */
export async function kleinunternehmerUmsaetze(period: VatPeriod, q: Db | Tx): Promise<RevenueSource[]> {
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
        eq(i.taxTreatment, "kleinunternehmer"),
        // aus Lexoffice übernommen: dort schon gemeldet
        isNull(i.lexofficeVoucherId),
        or(imZeitraum(i.issueDate), imZeitraum(i.serviceDate), imZeitraum(i.serviceFrom), imZeitraum(i.serviceTo)),
      ),
    );
  const rechnungen = kandidaten.filter((r) => leistungstag(r) >= start && leistungstag(r) < end);
  if (rechnungen.length === 0) return [];
  // Anzahlungen, auch ihr Storno und ihre Korrektur, zählen nicht
  const urspruenge = [...new Set(rechnungen.flatMap((r) => (r.correctsId ? [r.correctsId] : [])))];
  const anzahlungen = new Set(
    urspruenge.length === 0
      ? []
      : (
          await q
            .select({ id: i.id })
            .from(i)
            .where(and(inArray(i.id, urspruenge), eq(i.advanceType, "anzahlung")))
        ).map((r) => r.id),
  );
  const zaehlen = rechnungen.filter((r) => r.advanceType !== "anzahlung" && !(r.correctsId && anzahlungen.has(r.correctsId)));
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
  const kleinunternehmer = [...ohneRechnung, ...(await kleinunternehmerUmsaetze(period, q))];
  const kz48Kleinunternehmer = kleinunternehmer.reduce((s, r) => s + r.base, 0);
  return { ...kennzahlen, kz48: kennzahlen.kz48 + kz48Kleinunternehmer, kz48Kleinunternehmer, kleinunternehmerUmsaetze: kleinunternehmer };
}
