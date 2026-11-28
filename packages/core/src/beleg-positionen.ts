import { belegAnteile } from "./beleg-anteile.ts";
import { PRIVATENTNAHME, type ExpenseCategory } from "./kontenplan.ts";
import { taxOf, type BasisPoints, type Cents, type Prozent } from "./money.ts";

/*
 * Positionen eines Belegs (#1975, docs/adr/belege-positionen.md): Jeder Beleg besteht aus Positionen mit Kategorie, Satz,
 * Netto und Steuer; ein Privatanteil ist eine Position `privatentnahme`. Hier steht, wie aus der früheren Form
 * „Beträge je Satz, eine Kategorie und ein Privatanteil in Prozent“ Positionen werden und zurück, und wie die Beträge je
 * Satz aus den Positionen folgen.
 *
 * Aus der früheren Form entstehen die Positionen mit der Rundung des Privatanteils am Beleg (belegAnteile): privat
 * gerundet, betrieblich der Rest, für Netto und Steuer je Satz. So bucht ein überführter Beleg auf jedem Konto genau wie
 * vorher. Wer eine Position von Hand abspaltet (privatanteilAbspalten), teilt nur das Netto; die Steuer verteilt dann
 * allocateSplitTax nach Netto (#1976). Beides kann um einen Cent auseinanderliegen; die frühere Form behält deshalb ihre
 * Rechnung.
 */

/** Eine Position, soweit die Beträge sie brauchen; ohne Kategorie ist der Entwurf noch nicht zugeordnet */
export interface Satzposition {
  category: ExpenseCategory | null;
  taxRate: BasisPoints;
  net: Cents;
  tax: Cents;
  /** Nur bei Fremdwährung: Netto der Position laut Beleg */
  originalNet?: Cents | null;
}

/** Satz einer Position, wenn der Beleg noch keine Beträge hat: die Kategorie soll trotzdem stehen bleiben */
const SATZ_OHNE_BETRAEGE: BasisPoints = 1900;

/**
 * Positionen aus der früheren Form eines Belegs: je Satz eine Position der Kategorie, mit Privatanteil daneben eine
 * Position `privatentnahme` mit dem privaten Teil von Netto und Steuer, bei Fremdwährung auch des Nettos laut Beleg. Die
 * betriebliche Position bleibt auch mit 0 stehen (100 % privat), damit die Kategorie erhalten bleibt; eine Entnahme ganz
 * ohne Betrag entfällt. Ohne Beträge, aber mit Kategorie steht eine Position zu 19 % mit 0.
 */
export function positionenAusSaetzen(
  category: ExpenseCategory | null,
  privateShare: Prozent,
  amounts: readonly { taxRate: BasisPoints; net: Cents; tax: Cents; originalNet?: Cents | null }[],
): Satzposition[] {
  if (amounts.length === 0) return category ? [{ category, taxRate: SATZ_OHNE_BETRAEGE, net: 0, tax: 0 }] : [];
  return amounts.flatMap(({ taxRate, net, tax, originalNet }) => {
    const netto = belegAnteile(net, privateShare);
    const steuer = belegAnteile(tax, privateShare);
    const original = originalNet === undefined || originalNet === null ? null : belegAnteile(originalNet, privateShare);
    const mitOriginal = (betrag: Cents | undefined) => (original ? { originalNet: betrag! } : {});
    const betrieb: Satzposition = { category, taxRate, net: netto.business, tax: steuer.business, ...mitOriginal(original?.business) };
    if (netto.private === 0 && steuer.private === 0 && (original?.private ?? 0) === 0) return [betrieb];
    return [betrieb, { category: PRIVATENTNAHME, taxRate, net: netto.private, tax: steuer.private, ...mitOriginal(original?.private) }];
  });
}

const istEntnahme = (zeile: { category: string | null }) => zeile.category === PRIVATENTNAHME;

/**
 * Die eine betriebliche Kontierung der Positionen, neben beliebig vielen Entnahmen: die erste betriebliche Position, wenn
 * alle betrieblichen denselben Schlüssel haben (Standard: die Kategorie; der Server nimmt Kategorie und eigenes Konto).
 * null bei zwei Kontierungen, nur Entnahmen oder ohne Positionen. Ein solcher Beleg bucht wie ein Beleg mit einer
 * Kategorie (documentPosting), sonst wie eine Aufteilung (documentSplitPosting).
 */
export function einzigeKontierung<Z extends { category: string | null }>(
  zeilen: readonly Z[],
  schluessel: (zeile: Z) => string = (zeile) => String(zeile.category),
): Z | null {
  const betrieb = zeilen.filter((zeile) => !istEntnahme(zeile));
  const erste = betrieb[0];
  if (!erste) return null;
  return betrieb.every((zeile) => schluessel(zeile) === schluessel(erste)) ? erste : null;
}

const PROZENTE: Prozent[] = Array.from({ length: 100 }, (_, i) => i + 1);

/**
 * Der Privatanteil in Prozent, aus dem diese Positionen entstanden sein können (positionenAusSaetzen), für die Ansicht
 * in der früheren Form: 0 ohne Entnahme, null, wenn keine Prozentzahl genau diese Positionen ergibt oder ein Satz mehr
 * als eine betriebliche Position oder Entnahme hat. Die Kontierung prüft einzigeKontierung. Ergeben mehrere Sätze
 * dieselben Positionen (kleine Beträge), gilt der erste aus `vorschlag`, etwa die Vorgabe der Firmendaten.
 */
export function privatanteilDerPositionen(
  zeilen: readonly { category: string | null; taxRate: BasisPoints; net: Cents; tax: Cents }[],
  vorschlag: readonly Prozent[] = [],
): Prozent | null {
  const saetze = new Map<BasisPoints, { betrieb: { net: Cents; tax: Cents }[]; entnahme: { net: Cents; tax: Cents }[] }>();
  for (const zeile of zeilen) {
    const satz = saetze.get(zeile.taxRate) ?? { betrieb: [], entnahme: [] };
    (istEntnahme(zeile) ? satz.entnahme : satz.betrieb).push(zeile);
    saetze.set(zeile.taxRate, satz);
  }
  const je = [...saetze.values()];
  if (je.some((satz) => satz.betrieb.length !== 1 || satz.entnahme.length > 1)) return null;
  if (je.every((satz) => satz.entnahme.length === 0)) return 0;
  const passt = (prozent: Prozent) =>
    je.every(({ betrieb: [b], entnahme: [e] }) => {
      const privat = e ?? { net: 0, tax: 0 };
      const netto = belegAnteile(b!.net + privat.net, prozent);
      const steuer = belegAnteile(b!.tax + privat.tax, prozent);
      return netto.private === privat.net && steuer.private === privat.tax;
    });
  return [...vorschlag, ...PROZENTE].find(passt) ?? null;
}

/**
 * Beträge je Satz aus den Positionen: das Netto summiert, die Steuer kaufmännisch aus dem Netto, außer `steuer` nennt sie
 * für den Satz. Maßgeblich ist der Steuerbetrag laut Rechnung je Satz (§ 14 Abs. 4 Nr. 8 UStG); je Position gerundet
 * wiche die Summe um Cents ab, deshalb lässt er sich je Satz korrigieren. Absteigend nach Satz.
 */
export function betraegeAusPositionen(
  positionen: readonly { taxRate: BasisPoints; net: Cents }[],
  steuer: readonly { taxRate: BasisPoints; tax: Cents }[] = [],
): { taxRate: BasisPoints; net: Cents; tax: Cents }[] {
  const netto = new Map<BasisPoints, Cents>();
  for (const { taxRate, net } of positionen) netto.set(taxRate, (netto.get(taxRate) ?? 0) + net);
  return [...netto.entries()]
    .sort(([a], [b]) => b - a)
    .map(([taxRate, net]) => ({ taxRate, net, tax: steuer.find((s) => s.taxRate === taxRate)?.tax ?? taxOf(net, taxRate) }));
}
