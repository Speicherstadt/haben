import { ASSET_ACCOUNTS } from "./afa.ts";
import { heutigesKonto } from "./kontenaenderungen.ts";
import { ACCOUNTS, type Kontenrahmen } from "./kontenplan.ts";
import type { BasisPoints } from "./money.ts";
import type { TaxTreatment } from "./treatment.ts";

/*
 * Verkauf einer Anlage per Rechnung (#2022): Eine Rechnung mit „Verkauf aus dem Anlagevermögen“ bucht ihren Erlös auf
 * „Erlöse aus Verkäufen Sachanlagevermögen … (bei Buchgewinn)“ (DATEV-Kontenrahmen 2026, SKR03 8820–8829, SKR04
 * 4844–4849), Steuerschlüssel und Umsatzsteuerkonto bleiben die der Steuer der Rechnung. Nur wo DATEV ein passendes
 * Verkaufskonto hat: 19 % (AM), Ausfuhr und innergemeinschaftliche Lieferung (AM, Kz 43 bzw. 41) und Kleinunternehmer
 * (8829/4849 ohne Automatik, ohne Voranmeldung). Für 7 %, steuerfreie Umsätze nach § 4 Nr. 8 ff., § 13b, Drittland und
 * nicht steuerbare Leistungen gibt es keins; auf 8829/4849 fehlte in DATEV die Kennzahl der Voranmeldung (Kz 86, 48, 60,
 * 45). Diese Erlöse bleiben auf dem Erlöskonto mit Automatik, die EÜR liest das Kennzeichen der Rechnung. Den Restbuchwert kennt die
 * Rechnung nicht; bei einem Buchverlust bucht die Steuerberatung beim Abschluss um. In der EÜR steht der Erlös in Zeile 19
 * „Veräußerung oder Entnahme von Anlagevermögen“ (Anleitung zur EÜR 2025), der Restbuchwert getrennt als Ausgabe.
 */

/**
 * Verkaufskonto einer Rechnung mit „Verkauf aus dem Anlagevermögen“, nach Steuerbehandlung und Satz; null, wo DATEV keins mit
 * passender Kennzeichnung hat: dann bucht die Rechnung auf ihr Erlöskonto
 */
export function anlagenverkaufKonto(kontenrahmen: Kontenrahmen, treatment: TaxTreatment, rate: BasisPoints): string | null {
  const konten = ASSET_ACCOUNTS[kontenrahmen].verkauf;
  if (treatment === "regulaer" && rate === 1900) return konten.ust19;
  if (treatment === "ausfuhr") return konten.ausfuhr;
  if (treatment === "ig_lieferung") return konten.igLieferung;
  if (treatment === "kleinunternehmer") return konten.sonstige;
  return null;
}

/** Konten des Verkaufs (bei Buchgewinn und Buchverlust) und der Entnahme einer Anlage: in der EÜR immer Zeile 19 */
export function istAnlagenabgangKonto(kontenrahmen: Kontenrahmen, account: string): boolean {
  const konten = ASSET_ACCOUNTS[kontenrahmen];
  return [...Object.values(konten.verkauf), ...Object.values(konten.verkaufVerlust), ...Object.values(konten.entnahme)].includes(account as never);
}

/**
 * Erlöskonten, auf die eine Rechnung ohne „Verkauf aus dem Anlagevermögen“ bucht. Eine Rechnung mit dem Kennzeichen, die
 * vor #2022 festgeschrieben wurde, steht dort; die EÜR ordnet diese Zeilen nach dem Kennzeichen Zeile 19 zu.
 */
export function istRechnungsErloesKonto(kontenrahmen: Kontenrahmen, account: string): boolean {
  const a = ACCOUNTS[kontenrahmen];
  const heute = heutigesKonto(kontenrahmen, account);
  return [...Object.values(a.erloese), ...Object.values(a.erloeseSonder)].includes(heute as never);
}
