import type { DarlehenTeil } from "./darlehen.ts";
import { addDays, isNonWorkingDay, naechsterWerktag } from "./holidays.ts";
import type { LiquiditaetsPosten } from "./liquiditaet.ts";
import { nachBankdatenBeginn } from "./liquiditaet-steuern.ts";
import type { Cents } from "./money.ts";
import { addMonthsAnchored } from "./recurring.ts";
import type { Bundesland } from "./steuernummer.ts";

/*
 * Darlehensraten in der Liquiditätsvorschau (#1381). Haben speichert am Darlehen weder Rate noch Intervall; bis sie sich
 * erfassen lassen (#326), schreibt die Vorschau die im Bankabgleich zugeordneten Zahlungen fort:
 *
 * - Eine Rate ist alles, was an einem Tag als Tilgung und Zinsen zugeordnet ist. Hat das Darlehen Zinsen, zählt nur ein Tag
 *   mit Zinsen als Rate: Eine Sondertilgung an einem eigenen Tag verschiebt den Rhythmus so nicht. Gebühren werden nicht
 *   fortgeschrieben.
 * - Tilgung und Zinsen je Rate sind der häufigste Betrag der letzten drei Raten, sonst der mittlere: Eine Sondertilgung oder
 *   eine einmalig höhere Rate wird nicht fortgeschrieben.
 * - Der Rhythmus ist der Abstand der letzten Raten, gerundet auf 1, 3, 6 oder 12 Monate, der Tag im Monat der übliche der
 *   letzten Raten (ein Monatsende zählt als 31.). Fällt ein Termin auf ein Wochenende oder einen Feiertag, bucht die Bank am
 *   nächsten Werktag ab; der Tag im Monat ist deshalb der, zu dem die meisten der letzten drei Abbuchungen passen.
 * - Die Tilgungen enden am Bestand, die letzte Rate tilgt nur den Rest. Ohne Bestand steht nichts.
 * - Nur eine Rate: monatlich angenommen, geschätzt; sonst erwartet.
 * - Kam zwei Intervalle und 30 Tage lang keine Rate, gilt das Darlehen als ruhend (abgelöst, anders gezahlt) und steht nicht.
 * - Ein Termin vor heute bleibt überfällig stehen, wenn er nach dem ersten Bankumsatz liegt (wie bei den Steuern).
 */

/** Eine im Bankabgleich zugeordnete Zahlung zu einem Darlehen; Betrag mit dem Vorzeichen des Bankumsatzes (Ausgang negativ) */
export interface DarlehenZahlung {
  datum: string;
  teil: DarlehenTeil;
  betrag: Cents;
}

export interface DarlehenVerlauf {
  id: string;
  name: string;
  /** Restschuld heute, positiv */
  bestand: Cents;
  zahlungen: readonly DarlehenZahlung[];
}

export const DARLEHEN_RHYTHMEN = [1, 3, 6, 12] as const;
export type DarlehenRhythmus = (typeof DARLEHEN_RHYTHMEN)[number];

/** Tage, die eine Abbuchung vor ihrem Termin liegen darf und trotzdem zu ihm gehört (Monatsende am letzten Werktag davor) */
const VERSCHIEBUNG_TAGE = 3;
/** Ruhend nach so vielen Intervallen ohne Rate, plus `RUHEND_TAGE` */
const RUHEND_INTERVALLE = 2;
const RUHEND_TAGE = 30;

/** Der häufigste der letzten drei Werte; kommt keiner zweimal vor, der mittlere, bei weniger als drei der letzte */
function ueblich(werte: readonly number[]): number {
  const letzte = werte.slice(-3);
  const doppelt = letzte.find((w, i) => letzte.indexOf(w) !== i);
  if (doppelt !== undefined) return doppelt;
  return letzte.length === 3 ? [...letzte].sort((a, b) => a - b)[1]! : letzte.at(-1)!;
}

const tageZwischen = (von: string, bis: string) => (Date.parse(`${bis}T00:00:00Z`) - Date.parse(`${von}T00:00:00Z`)) / 86_400_000;

/** Abstand in Monaten, gerundet auf 1, 3, 6 oder 12: unter 2 Monaten monatlich, unter 4½ vierteljährlich, unter 9 halbjährlich */
function rhythmusAus(tage: number): DarlehenRhythmus {
  const monate = tage / 30.44;
  if (monate < 2) return 1;
  if (monate < 4.5) return 3;
  if (monate < 9) return 6;
  return 12;
}

/** Rhythmus aus den Tagen der Raten (aufsteigend): der übliche der letzten drei Abstände; bei einer Rate monatlich */
export function darlehenRhythmus(raten: readonly string[]): DarlehenRhythmus {
  const abstaende = raten.slice(-4).flatMap((datum, i, liste) => (i === 0 ? [] : [rhythmusAus(tageZwischen(liste[i - 1]!, datum))]));
  return abstaende.length === 0 ? 1 : (ueblich(abstaende) as DarlehenRhythmus);
}

const monatsende = (datum: string) => addDays(datum, 1).slice(8) === "01";
/** Tag im Monat; das Monatsende zählt als 31., damit der 28. Februar einen Termin am 31. nicht verschiebt */
const tagImMonat = (datum: string) => (monatsende(datum) ? 31 : Number(datum.slice(8)));

/** Tage, für die eine Abbuchung am Tag `datum` fällig gewesen sein kann: er selbst und die arbeitsfreien Tage direkt davor */
function moeglicheTermine(datum: string, bundesland: Bundesland | null): string[] {
  const tage = [datum];
  for (let tag = addDays(datum, -1); isNonWorkingDay(tag, bundesland); tag = addDays(tag, -1)) tage.push(tag);
  return tage;
}

/**
 * Tag im Monat der Termine: der, zu dem die meisten der letzten drei Abbuchungen passen, auch über ein Wochenende oder einen
 * Feiertag verschoben; bei Gleichstand der Tag der älteren Abbuchung
 */
function ankerAus(raten: readonly string[], bundesland: Bundesland | null): number {
  const letzte = raten.slice(-3).map((datum) => moeglicheTermine(datum, bundesland));
  const passend = (anker: number) => letzte.filter((tage) => tage.some((tag) => addMonthsAnchored(tag, 0, anker) === tag)).length;
  return letzte
    .flat()
    .map(tagImMonat)
    .reduce((bester, anker) => (passend(anker) > passend(bester) ? anker : bester));
}

/** Termin, zu dem die Abbuchung am Tag `datum` gehört: der letzte Tag `anker` vor ihr oder bis `VERSCHIEBUNG_TAGE` danach */
function terminDer(datum: string, anker: number): string {
  const spaetestens = addDays(datum, VERSCHIEBUNG_TAGE);
  const imMonat = addMonthsAnchored(spaetestens, 0, anker);
  return imMonat <= spaetestens ? imMonat : addMonthsAnchored(spaetestens, -1, anker);
}

interface Rate {
  datum: string;
  tilgung: Cents;
  zinsen: Cents;
}

/** Raten je Tag aus den Zahlungen: Ausgänge für Tilgung und Zinsen, aufsteigend; Auszahlung und Gebühren zählen nicht */
function ratenAus(zahlungen: readonly DarlehenZahlung[]): Rate[] {
  const tage = new Map<string, Rate>();
  for (const z of zahlungen) {
    if (z.teil !== "tilgung" && z.teil !== "zins") continue;
    const rate = tage.get(z.datum) ?? { datum: z.datum, tilgung: 0, zinsen: 0 };
    if (z.teil === "tilgung") rate.tilgung -= z.betrag;
    else rate.zinsen -= z.betrag;
    tage.set(z.datum, rate);
  }
  const raten = [...tage.values()].filter((r) => r.tilgung > 0 || r.zinsen > 0).sort((a, b) => a.datum.localeCompare(b.datum));
  // Mit Zinsen ist ein Tag ohne Zinsen eine Sondertilgung, keine Rate
  return raten.slice(-3).some((r) => r.zinsen > 0) ? raten.filter((r) => r.zinsen > 0) : raten;
}

/**
 * Künftige und überfällige Raten eines Darlehens bis `bis` (einschließlich), dazu ein Hinweis, wenn Haben die Rate nicht
 * kennt. Regeln oben im Kopf der Datei.
 */
export function darlehensPosten(input: {
  darlehen: DarlehenVerlauf;
  heute: string;
  bis: string;
  bundesland: Bundesland | null;
  /** Tag des ersten Bankumsatzes der Konten im Bestand; null ohne Umsätze */
  bankdatenAb: string | null;
}): { posten: LiquiditaetsPosten[]; hinweis: string | null } {
  const { darlehen, heute, bis } = input;
  if (darlehen.bestand <= 0) return { posten: [], hinweis: null };
  const raten = ratenAus(darlehen.zahlungen);
  if (raten.length === 0) {
    return { posten: [], hinweis: `Für das Darlehen „${darlehen.name}“ ist noch keine Rate zugeordnet; sie fehlt in der Vorschau.` };
  }
  const rhythmus = darlehenRhythmus(raten.map((r) => r.datum));
  const anker = ankerAus(
    raten.map((r) => r.datum),
    input.bundesland,
  );
  const letzter = terminDer(raten.at(-1)!.datum, anker);
  if (addDays(addMonthsAnchored(letzter, RUHEND_INTERVALLE * rhythmus, anker), RUHEND_TAGE) < heute) return { posten: [], hinweis: null };

  const tilgung = ueblich(raten.map((r) => r.tilgung));
  const zinsen = ueblich(raten.map((r) => r.zinsen));
  const geschaetzt = raten.length === 1;
  const posten: LiquiditaetsPosten[] = [];
  let rest = darlehen.bestand;
  for (let k = 1; rest > 0; k++) {
    const datum = naechsterWerktag(addMonthsAnchored(letzter, k * rhythmus, anker), input.bundesland);
    if (datum > bis) break;
    if (datum < heute && !nachBankdatenBeginn(datum, input.bankdatenAb)) continue;
    const getilgt = Math.min(tilgung, rest);
    rest -= getilgt;
    const schluss = tilgung > 0 && rest === 0;
    posten.push({
      datum,
      betrag: getilgt + zinsen,
      richtung: "aus",
      text: `${darlehen.name}, ${schluss ? "Schlussrate" : geschaetzt ? "Rate wie zuletzt gezahlt, monatlich angenommen" : "Rate wie zuletzt gezahlt"}`,
      quelle: { art: "darlehen", id: darlehen.id },
      sicherheit: geschaetzt ? "geschaetzt" : "erwartet",
    });
  }
  return { posten, hinweis: null };
}
