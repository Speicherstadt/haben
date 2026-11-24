import { amountError, formatDecimal, parseEuro } from "@haben/core";
import type { EstArbeitnehmer, EstLohnsteuerbescheinigung } from "@haben/elster";
import { betragLesen, type Fehler, HOECHSTBETRAG, zahlLesen } from "./eingabe-pruefung.ts";

/** Beträge einer Lohnsteuerbescheinigung, Nummern wie auf der Bescheinigung */
export const BETRAEGE = [
  ["brutto", "Nr. 3 Bruttoarbeitslohn"],
  ["lohnsteuer", "Nr. 4 Lohnsteuer"],
  ["soli", "Nr. 5 Solidaritätszuschlag"],
  ["kirchensteuer", "Nr. 6 Kirchensteuer"],
  ["kirchensteuerEhegatte", "Nr. 7 Kirchensteuer Ehegatte"],
  ["rvArbeitgeber", "Nr. 22a Rentenversicherung Arbeitgeber"],
  ["rvArbeitnehmer", "Nr. 23a Rentenversicherung Arbeitnehmer"],
  ["kvArbeitnehmer", "Nr. 25 Krankenversicherung"],
  ["pvArbeitnehmer", "Nr. 26 Pflegeversicherung"],
  ["avArbeitnehmer", "Nr. 27 Arbeitslosenversicherung"],
] as const;

export type BetragKey = (typeof BETRAEGE)[number][0];

export type BescheinigungDraft = { key: number; steuerklasse: string } & Record<BetragKey, string>;

export const WK_BETRAEGE = [
  ["arbeitsmittel", "Arbeitsmittel", "z. B. Laptop, Fachliteratur, Arbeitskleidung"],
  ["fortbildung", "Fortbildung", undefined],
  ["gewerkschaft", "Gewerkschaft", "ab 2026 zusätzlich zum Pauschbetrag"],
  ["berufsverbaende", "Berufsverbände", undefined],
  ["arbeitszimmer", "Häusliches Arbeitszimmer", "nur als Mittelpunkt der gesamten Tätigkeit: Kosten oder Pauschale 1.260 €, je Monat ohne 105 € weniger"],
  ["sonstige", "Weitere Werbungskosten", "z. B. Kontoführung pauschal 16 €, Bewerbungen"],
] as const;

export type WkKey = (typeof WK_BETRAEGE)[number][0];

export type ArbeitnehmerDraft = {
  aktiv: boolean;
  bescheinigungen: BescheinigungDraft[];
  tage: string;
  km: string;
  adresse: string;
  arbeitstageJeWoche: string;
  urlaubstage: string;
  homeofficeTage: string;
  keinAndererArbeitsplatz: boolean;
  /** Monate, in denen das Arbeitszimmer wenigstens zeitweise der Mittelpunkt der gesamten Tätigkeit war */
  arbeitszimmerMonate: string;
} & Record<WkKey, string>;

/** Höchstzahl der Bescheinigungen je Person wie im Schema des Servers */
export const HOECHSTENS_BESCHEINIGUNGEN = 10;

/** Schlüssel eines Felds für useSubmitCheck: je Person, die Beträge einer Bescheinigung auch je Bescheinigung */
export const anSchluessel = (p: "a" | "b", feld: string, bescheinigung?: number) =>
  bescheinigung === undefined ? `an-${p}-${feld}` : `an-${p}-${bescheinigung}-${feld}`;

const BRUTTO_BEISPIEL = 4_200_000;
const BRUTTO = amountError("den Bruttoarbeitslohn", BRUTTO_BEISPIEL);
const BRUTTO_GRENZE = amountError(`einen Bruttoarbeitslohn bis ${formatDecimal(HOECHSTBETRAG)}`, BRUTTO_BEISPIEL);
// Grenzen wie im Schema des Servers (`arbeitnehmer` in `jahreserklaerung/income-tax.ts`)
const TAGE = { min: 1, max: 366, meldung: "Trag die Tage an der Tätigkeitsstätte als ganze Zahl von 1 bis 366 ein." };
const KM = { min: 1, max: 9999, ganz: false, meldung: "Trag die einfache Entfernung von 1 bis 9.999 km ein, etwa 12,5." };
const ADRESSE = "Trag die Anschrift der ersten Tätigkeitsstätte ein.";
const ARBEITSTAGE = { min: 1, max: 7, meldung: "Trag die Arbeitstage je Woche als ganze Zahl von 1 bis 7 ein, oder lass das Feld leer." };
const URLAUB = { min: 0, max: 366, meldung: "Trag die Urlaubs- und Krankheitstage als ganze Zahl bis 366 ein, oder lass das Feld leer." };
const HOMEOFFICE = { min: 0, max: 366, meldung: "Trag die Homeoffice-Tage als ganze Zahl bis 366 ein, oder lass das Feld leer." };
const MONATE = { min: 0, max: 12, meldung: "Trag die Monate als ganze Zahl von 0 bis 12 ein, oder lass das Feld leer." };

function bescheinigungLesen(b: BescheinigungDraft, p: "a" | "b", fehler: Fehler): EstLohnsteuerbescheinigung {
  const werte = Object.fromEntries(BETRAEGE.map(([k]) => [k, betragLesen(fehler, anSchluessel(p, k, b.key), b[k])])) as Partial<Record<BetragKey, number>>;
  // Pflichtangabe: leer, 0 oder nicht lesbar sagt dasselbe
  const brutto = parseEuro(b.brutto);
  fehler[anSchluessel(p, "brutto", b.key)] = brutto === null || brutto <= 0 ? BRUTTO : brutto > HOECHSTBETRAG ? BRUTTO_GRENZE : null;
  return { ...werte, steuerklasse: Number(b.steuerklasse) as EstLohnsteuerbescheinigung["steuerklasse"], brutto: werte.brutto ?? 0 };
}

/** Wege zur Arbeit: Ist eines der Felder ausgefüllt, braucht der Server Tage, Entfernung und Anschrift */
function wegeLesen(d: ArbeitnehmerDraft, p: "a" | "b", fehler: Fehler) {
  const k = (feld: string) => anSchluessel(p, feld);
  const tage = zahlLesen(fehler, k("tage"), d.tage, TAGE);
  const km = zahlLesen(fehler, k("km"), d.km, KM);
  const arbeitstageJeWoche = zahlLesen(fehler, k("arbeitstageJeWoche"), d.arbeitstageJeWoche, ARBEITSTAGE);
  const urlaubstage = zahlLesen(fehler, k("urlaubstage"), d.urlaubstage, URLAUB);
  const adresse = d.adresse.trim();
  fehler[k("adresse")] = null;
  if (![d.tage, d.km, adresse, d.arbeitstageJeWoche, d.urlaubstage].some((text) => text.trim())) return undefined;
  if (!d.tage.trim()) fehler[k("tage")] = TAGE.meldung;
  if (!d.km.trim()) fehler[k("km")] = KM.meldung;
  if (!adresse) fehler[k("adresse")] = ADRESSE;
  if (tage === undefined || km === undefined || !adresse) return undefined;
  return { tage, km, adresse, ...(arbeitstageJeWoche ? { arbeitstageJeWoche } : {}), ...(urlaubstage ? { urlaubstage } : {}) };
}

/** Liest die Anlage N einer Person; jeder Fehler landet unter dem Schlüssel seines Felds (`anSchluessel`) in `fehler` */
export function anlageNLesen(d: ArbeitnehmerDraft, p: "a" | "b", fehler: Fehler): EstArbeitnehmer | undefined {
  if (!d.aktiv) return undefined;
  const k = (feld: string) => anSchluessel(p, feld);
  const bescheinigungen = d.bescheinigungen.map((b) => bescheinigungLesen(b, p, fehler));
  const wege = wegeLesen(d, p, fehler);
  return {
    bescheinigungen,
    werbungskosten: {
      ...(wege ? { wege } : {}),
      // Eine 0 heißt „nichts“; bei den Monaten des Arbeitszimmers zählt sie (#940)
      homeofficeTage: zahlLesen(fehler, k("homeofficeTage"), d.homeofficeTage, HOMEOFFICE) || undefined,
      keinAndererArbeitsplatz: d.keinAndererArbeitsplatz || undefined,
      ...(Object.fromEntries(WK_BETRAEGE.map(([w]) => [w, betragLesen(fehler, k(w), d[w])])) as Partial<Record<WkKey, number>>),
      arbeitszimmerMonate: zahlLesen(fehler, k("arbeitszimmerMonate"), d.arbeitszimmerMonate, MONATE),
    },
  };
}
