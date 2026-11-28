import {
  allocateSplitTax,
  betraegeAusPositionen,
  distribute,
  privatanteilDerPositionen,
  type BasisPoints,
  type Cents,
  type ExpenseCategory,
  type Prozent,
} from "@haben/core";
import { einzigePosition, ohnePlatz, positionenAusBeleg, type Belegposition, type NeuePosition } from "./positionen.ts";
import type { SplitInput } from "./splits.ts";

/*
 * Eingabe eines Belegs in Positionen (#1975, docs/adr/belege-positionen.md). Gespeichert werden nur Positionen; drei
 * Formen der Eingabe führen dorthin:
 *
 * - `positions`: Positionen mit Netto in Belegwährung. Die Beträge je Satz folgen daraus (betraegeAusPositionen); die
 *   Steuer je Satz bleibt laut Rechnung korrigierbar (§ 14 Abs. 4 Nr. 8 UStG) und steht dann in `amounts`.
 * - `splits`: die Aufteilung des bisherigen Formulars, mit Beträgen je Satz daneben.
 * - sonst Kategorie, eigenes Konto und Privatanteil am Beleg mit Beträgen je Satz (bisheriges Formular, Übergang). Daraus
 *   wird je Satz eine Position und für den Privatanteil eine Entnahme, gerundet wie bisher gebucht (positionenAusBeleg).
 *
 * Kategorie, eigenes Konto und Privatanteil am Beleg speichert Haben danach nicht mehr; für das bisherige Formular stellt
 * `formularansicht` die Positionen wieder in dieser Form dar, solange sie sich so darstellen lassen.
 */

type Satzzeile = {
  taxRate: BasisPoints;
  net: Cents;
  tax: Cents;
  vorsteuerAnteil: BasisPoints | null;
  originalNet: Cents | null;
  originalTax: Cents | null;
};

/** Die Eingabe, soweit sie die Kontierung betrifft */
export interface Kontierungseingabe {
  category: ExpenseCategory | null;
  ownAccountId: string | null;
  privateShare: Prozent;
  currency: string;
  amounts: Satzzeile[];
  splits: SplitInput[];
  positions: SplitInput[];
}

const fremd = (eingabe: { currency: string }) => eingabe.currency !== "EUR";

/**
 * Beträge je Satz der Eingabe: mit `positions` aus ihnen summiert, die Steuer je Satz aus `amounts`, wenn sie dort für den
 * Satz steht, sonst kaufmännisch aus dem Netto; Vorsteueranteil je Satz aus `amounts`. Bei Fremdwährung gilt das für die
 * Beträge laut Beleg, Euro rechnet euroAmounts mit dem Kurs. Ohne `positions` die Beträge wie eingegeben.
 */
export function betraegeDerEingabe(eingabe: Kontierungseingabe): Satzzeile[] {
  if (eingabe.positions.length === 0) return eingabe.amounts;
  const korrektur = (rate: BasisPoints) => eingabe.amounts.find((a) => a.taxRate === rate);
  const steuer = eingabe.amounts.flatMap((a) => {
    const tax = fremd(eingabe) ? a.originalTax : a.tax;
    return tax === null ? [] : [{ taxRate: a.taxRate, tax }];
  });
  return betraegeAusPositionen(eingabe.positions, steuer).map(({ taxRate, net, tax }) => {
    const vorsteuerAnteil = korrektur(taxRate)?.vorsteuerAnteil ?? null;
    return fremd(eingabe)
      ? { taxRate, net: 0, tax: 0, vorsteuerAnteil, originalNet: net, originalTax: tax }
      : { taxRate, net, tax, vorsteuerAnteil, originalNet: null, originalTax: null };
  });
}

/** Euro-Netto je Position: in Euro wie eingegeben, bei Fremdwährung das Euro-Netto des Satzes nach dem Netto laut Beleg */
function inEuro<P extends { taxRate: BasisPoints; net: Cents }>(positionen: readonly P[], euro: readonly { taxRate: BasisPoints; net: Cents }[]): Cents[] {
  const result = positionen.map(() => 0);
  for (const satz of euro) {
    const idx = positionen.flatMap((p, i) => (p.taxRate === satz.taxRate ? [i] : []));
    const teile = distribute(
      satz.net,
      idx.map((i) => positionen[i]!.net),
    );
    idx.forEach((i, k) => {
      result[i] = teile[k]!;
    });
  }
  return result;
}

/** Positionen mit Euro-Netto: die Steuer des Satzes verteilt allocateSplitTax nach Netto (#1976) */
function mitSteuer(positionen: readonly Omit<NeuePosition, "tax">[], euro: readonly { taxRate: BasisPoints; net: Cents; tax: Cents }[]): NeuePosition[] {
  const verteilt = allocateSplitTax(
    positionen.map((p) => ({ category: p.category as ExpenseCategory, taxRate: p.taxRate, net: p.net })),
    euro.map(({ taxRate, net, tax }) => ({ taxRate, net, tax })),
  );
  return positionen.map((p, i) => ({ ...p, tax: verteilt[i]!.tax }));
}

/** Positionen der Eingabe mit den Euro-Beträgen je Satz (euroAmounts) */
export function positionenDerEingabe(eingabe: Kontierungseingabe, euro: readonly Satzzeile[]): NeuePosition[] {
  if (eingabe.positions.length > 0) {
    const netto = fremd(eingabe) ? inEuro(eingabe.positions, euro) : eingabe.positions.map((p) => p.net);
    return mitSteuer(
      eingabe.positions.map((p, i) => ({
        category: p.category,
        ownAccountId: p.ownAccountId,
        taxRate: p.taxRate,
        net: netto[i]!,
        description: p.description,
        originalNet: fremd(eingabe) ? p.net : null,
      })),
      euro,
    );
  }
  if (eingabe.splits.length > 0) {
    return mitSteuer(
      eingabe.splits.map((s) => ({ ...s, originalNet: null })),
      euro,
    );
  }
  return ohnePlatz(positionenAusBeleg({ ...eingabe, fremd: fremd(eingabe) }, euro));
}

/**
 * Die bisherige Form der Positionen: eine Kontierung (Kategorie, eigenes Konto) und ein Privatanteil in Prozent, aus dem
 * die Entnahmen entstanden sein können; null, wenn die Positionen anders aussehen (mehrere Kontierungen, eine Beschreibung,
 * eine Entnahme, die keine Prozentzahl ergibt). Bei Fremdwährung zählt das Netto laut Beleg, weil die Euro-Beträge ohne
 * Kurs 0 sind. `vorgabe` sind Prozentsätze, die bei mehreren passenden zuerst gelten, etwa die der Firmendaten.
 */
export function bisherigeForm(
  positionen: readonly Belegposition[],
  istFremd: boolean,
  vorgabe: (category: string | null) => Prozent | undefined = () => undefined,
): { category: ExpenseCategory | null; ownAccountId: string | null; privateShare: Prozent } | null {
  const eine = einzigePosition(positionen);
  if (positionen.length > 0 && !eine) return null;
  if (positionen.some((p) => p.description !== "")) return null;
  const zeilen = positionen.map((p) => ({ ...p, net: istFremd ? (p.originalNet ?? 0) : p.net, tax: istFremd ? 0 : p.tax }));
  const vorschlag = vorgabe(eine?.category ?? null);
  const privateShare = privatanteilDerPositionen(zeilen, vorschlag === undefined ? [] : [vorschlag]);
  if (privateShare === null) return null;
  return { category: (eine?.category as ExpenseCategory | null | undefined) ?? null, ownAccountId: eine?.ownAccountId ?? null, privateShare };
}

/**
 * Positionen eines offenen Belegs nach einem neuen Kurs (applyPublishedRates): in der bisherigen Form neu aus den Euro-
 * Beträgen, gerundet wie bisher gebucht; sonst je Satz nach dem Netto laut Beleg verteilt.
 */
export function positionenZumKurs(positionen: readonly Belegposition[], euro: readonly Satzzeile[]): NeuePosition[] {
  const form = bisherigeForm(positionen, true);
  if (form) return ohnePlatz(positionenAusBeleg({ ...form, fremd: true }, euro));
  const nachBeleg = positionen.map((p) => ({ ...p, net: p.originalNet ?? 0 }));
  const netto = inEuro(nachBeleg, euro);
  return mitSteuer(
    positionen.map(({ position: _position, tax: _tax, ...p }, i) => ({ ...p, net: netto[i]! })),
    euro,
  );
}

/**
 * Der Beleg, wie ihn das bisherige Formular erwartet (Übergang bis zum Formular mit Positionen, #1975): Kategorie, eigenes
 * Konto und Privatanteil am Beleg aus den Positionen, wenn sie sich so darstellen lassen (bisherigeForm), sonst die
 * Positionen als Aufteilung. Festgeschriebener Altbestand trägt die Angaben noch selbst und bleibt, wie er ist.
 */
export function formularansicht<D extends { category: string | null; ownAccountId: string | null; privateShare: Prozent; currency: string }>(
  doc: D,
  positionen: readonly Belegposition[],
  vorgabe: (category: string | null) => Prozent | undefined = () => undefined,
): { document: D; splits: Belegposition[] } {
  if (doc.category !== null || doc.ownAccountId !== null || doc.privateShare !== 0) return { document: doc, splits: [] };
  const form = bisherigeForm(positionen, fremd(doc), vorgabe);
  if (form) return { document: { ...doc, ...form }, splits: [] };
  return { document: doc, splits: [...positionen] };
}
