import { ASSET_ACCOUNTS } from "./afa.ts";
import type { BasisPoints } from "./money.ts";
import { ACCOUNTS, KLEINUNTERNEHMER_FRUEHERE_KONTEN, type Kontenrahmen } from "./kontenplan.ts";
import type { TaxTreatment } from "./treatment.ts";

/*
 * Verkauf einer Anlage per Rechnung (#2022): Eine Rechnung mit „Verkauf aus dem Anlagevermögen“ bucht ihren Erlös auf
 * „Erlöse aus Verkäufen Sachanlagevermögen … (bei Buchgewinn)“ (DATEV-Kontenrahmen 2026, SKR03 8820–8829, SKR04
 * 4844–4849), Steuerschlüssel und Umsatzsteuerkonto bleiben die der Steuer der Rechnung. Den Restbuchwert kennt die
 * Rechnung nicht; bei einem Buchverlust bucht die Steuerberatung beim Abschluss um. In der EÜR steht der Erlös in Zeile 19
 * „Veräußerung oder Entnahme von Anlagevermögen“ (Anleitung zur EÜR 2025), der Restbuchwert getrennt als Ausgabe.
 */

/** Erlöskonto einer Rechnung mit „Verkauf aus dem Anlagevermögen“, nach Steuerbehandlung und Satz */
export function anlagenverkaufKonto(kontenrahmen: Kontenrahmen, treatment: TaxTreatment, rate: BasisPoints): string {
  const konten = ASSET_ACCOUNTS[kontenrahmen].verkauf;
  if (treatment === "regulaer" && rate === 1900) return konten.ust19;
  if (treatment === "ausfuhr") return konten.ausfuhr;
  if (treatment === "ig_lieferung") return konten.igLieferung;
  // 7 %, 0 %, Kleinunternehmer, steuerfrei nach § 4 Nr. 8 ff., § 13b, nicht steuerbar: ohne eigenes Konto bei DATEV
  return konten.sonstige;
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
  return [...Object.values(a.erloese), ...Object.values(a.erloeseSonder), KLEINUNTERNEHMER_FRUEHERE_KONTEN[kontenrahmen]].includes(account as never);
}
