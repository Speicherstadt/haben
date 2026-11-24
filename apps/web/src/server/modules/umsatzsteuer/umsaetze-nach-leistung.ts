import { periodRange, type Cents, type JournalKennzahlen, type VatPeriod, type Versteuerung } from "@haben/core";
import type { Db, Tx } from "../../db/index.ts";
import { leistungstag, nachLeistungBisZurRueckzahlung } from "../rechnungen/index.ts";
import { ausbuchungenNachLeistung, gehalteneMinderungen, rechnungenNachLeistung, summe, type Zaehlt } from "./leistung-belege.ts";
import { steuerfreiNachLeistung } from "./steuerfrei-nach-leistung.ts";
import type { RevenueSource } from "./vat-figures.ts";
import { kennzahlenAusDemJournal } from "./vat-journal.ts";

/*
 * Steuerfreie Umsätze im Zeitraum der Leistung, auch bei Ist-Versteuerung: Kz 48 (§ 4 Nr. 8 bis 29 und § 19 Abs. 1 UStG)
 * und Kz 43 (Ausfuhr). Die Anleitung zur UStVA 2026 sagt unter beiden Kennzahlen: „Anzahlungen zu steuerfreien Umsätzen
 * tragen Sie bitte nicht ein. Den Gesamtbetrag (Anzahlungen und Restzahlung) geben Sie bitte im Voranmeldungszeitraum der
 * Leistungsausführung an.“ Eine Ausnahme für die Ist-Versteuerung nennt sie nicht
 * (https://www.elster.de/eportal/helpGlobal?themaGlobal=help_ustva_2026#kz48 und #kz43). Rechnungen zählen nach dem
 * Leistungstag; Anzahlungen nicht, die Schlussrechnung mit den abgezogenen Anzahlungen. Die Anleitung verlangt unter
 * „Allgemein“, Entgeltminderungen bei den Bemessungsgrundlagen zu berücksichtigen (§ 17 UStG): Storno und Korrektur zählen
 * im Monat ihres Datums, schon bezahltes Entgelt mindern sie aber erst mit der Rückzahlung, wie in Kz 81 und 86 (#1228,
 * UStAE 17.1 Abs. 2 Satz 3; rechnungen/rueckzahlung-nach-leistung.ts); Skonto und Forderungsausfall buchen nur Unbezahltes
 * aus und zählen im Monat der Ausbuchung bzw. ihrer Aufhebung. Bareinnahmen und direkt gebuchte Erlöse ohne Rechnung zählen
 * am Tag der Zahlung: Ohne Rechnung kennt Haben keinen anderen Tag (bareinnahme.ts, direkt-kategorie.ts in @haben/core).
 *
 * Umsätze als Kleinunternehmer (#1268): Das Journal trägt sie mit dem Steuerschlüssel „KU“, der in keine Kennzahl führt;
 * die Summe kommt bei Ist und Soll aus Rechnungen, Bareinnahmen und Direktbuchungen. Erst ab 2025: Vorher war ein Umsatz
 * nach § 19 Abs. 1 nicht steuerfrei, Kz 48 der UStVA 2024 nennt nur § 4 Nr. 8 bis 29, die der UStVA 2025 auch § 19 Abs. 1
 * (ERiC 44.3.6.0, UStVA-2024.xsd und UStVA-2025.xsd, Element Kz48). Storno, Korrektur und Ausbuchung eines Umsatzes von
 * 2024 mindern Kz 48 deshalb auch 2025 nicht.
 *
 * § 4 UStG und Ausfuhr (#1312): steuerfrei-nach-leistung.ts, dort auch der Übergang (nur Rechnungen mit Kennzeichen).
 */

const STEUERFREI_AB = "2025-01-01";

/**
 * Kleinunternehmer: Entscheidend ist der Anfang der Kette. Anzahlungen zählen nicht, auch nicht ihr Storno, ihre Korrektur
 * und deren Storno, das auf die Korrektur verweist (cancelInvoice), und Leistungen vor 2025 nicht
 */
const kleinunternehmerZaehlt: Zaehlt = async (r, taxes) => {
  const anfang = await taxes.original(r);
  return anfang.advanceType !== "anzahlung" && leistungstag(anfang) >= STEUERFREI_AB;
};

/** Die Umsätze als Kleinunternehmer im Zeitraum: Rechnungen, Ausbuchungen, gehaltene Minderungen, Bareinnahmen und Direktbuchungen */
async function kleinunternehmerUmsaetze(period: VatPeriod, revenue: readonly RevenueSource[], q: Db | Tx): Promise<RevenueSource[]> {
  if (periodRange(period).start < STEUERFREI_AB) return [];
  const ohneRechnung = revenue.filter((r) => (r.type === "kasse" || r.type === "direkt") && r.treatment === "kleinunternehmer");
  return [
    ...ohneRechnung,
    ...(await rechnungenNachLeistung(period, ["kleinunternehmer"], kleinunternehmerZaehlt, q)),
    ...(await ausbuchungenNachLeistung(period, ["kleinunternehmer"], kleinunternehmerZaehlt, q)),
    ...(await gehalteneMinderungen(period, ["kleinunternehmer"], kleinunternehmerZaehlt, (r, taxes) => nachLeistungBisZurRueckzahlung(r, q, taxes), q)),
  ];
}

/**
 * Die Kennzahlen der Voranmeldung: aus dem Journal (#542, #1116), wie bei DATEV aus Konto und Steuerschlüssel; dazu die
 * Privatnutzung von Fahrzeugen je Monat aus dem Anlagenverzeichnis (das Journal bucht sie erst mit der AfA), die Umsätze
 * als Kleinunternehmer in Kz 48, die das Journal ohne Kennzahl trägt (#1268), und Kz 43 und 48 für § 4 und Ausfuhr im
 * Zeitraum der Leistung, ohne Anzahlungen (#1312). `revenue` sind die Quellen unter den Kennzahlen, passend dazu.
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
    revenue: RevenueSource[];
  }
> {
  const { kennzahlen, ...journal } = await kennzahlenAusDemJournal(period, versteuerung, q);
  const entnahme = revenue.filter((r) => r.type === "entnahme");
  kennzahlen.kz81 += summe(entnahme);
  kennzahlen.tax81 += entnahme.reduce((s, r) => s + r.tax, 0);
  const steuerfrei = await steuerfreiNachLeistung(period, versteuerung, journal, revenue, q);
  const kleinunternehmer = await kleinunternehmerUmsaetze(period, revenue, q);
  const kz48Kleinunternehmer = summe(kleinunternehmer);
  return {
    ...kennzahlen,
    kz43: kennzahlen.kz43 + steuerfrei.kz43,
    kz48: kennzahlen.kz48 + steuerfrei.kz48 + kz48Kleinunternehmer,
    kz48Kleinunternehmer,
    kleinunternehmerUmsaetze: kleinunternehmer,
    revenue: steuerfrei.revenue,
  };
}
