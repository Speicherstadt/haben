import type { PriceMode } from "./invoice.ts";
import { roundHalfAwayFromZero, taxOf, type BasisPoints, type Cents } from "./money.ts";
import { discountBasis, discountedLineAmount, splitDocumentDiscount, type Discount, type DiscountableLine } from "./rabatt.ts";

/**
 * Position mit Kennzeichen „Arbeits-, Maschinen- und Fahrtkosten“ (§ 35a Abs. 5 Satz 2 EStG; BMF-Schreiben vom
 * 09.11.2016, BStBl I S. 1213, geändert durch BMF-Schreiben vom 01.09.2021, BStBl I S. 1494, Rz. 39: Arbeitskosten
 * einschließlich der in Rechnung gestellten Maschinen- und Fahrtkosten, ohne Material)
 */
export interface ArbeitskostenLine extends DiscountableLine {
  taxRate: BasisPoints;
  arbeitskosten?: boolean | undefined;
  /** Abzugsposition einer Schlussrechnung: trägt kein Kennzeichen und zählt nicht zur Grundlage */
  deductionOf?: string | null | undefined;
}

/**
 * Anteil der Arbeits-, Maschinen- und Fahrtkosten einer Rechnung, brutto inklusive Umsatzsteuer, wie ihn der Kunde für
 * § 35a EStG ansetzt; null, wenn keine Position gekennzeichnet ist.
 *
 * Je Steuersatz die gekennzeichneten Positionen nach Positionsrabatt, um ihren Anteil am Gesamtrabatt des Satzes gemindert
 * (splitDocumentDiscount verteilt den Rabatt wie in computeInvoice). Bei Nettopreisen kommt die Steuer des Satzes dazu.
 * Der Kunde muss den Anteil aus der Rechnung ermitteln können (BMF Rz. 40); einen eigenen Ausweis der Umsatzsteuer darauf
 * verlangt das Schreiben nicht.
 */
export function arbeitskostenAnteil(lines: ArbeitskostenLine[], priceMode: PriceMode, discount: Discount | null = null): Cents | null {
  if (!lines.some((line) => line.arbeitskosten && !line.deductionOf)) return null;
  let total = 0;
  for (const [rate, { anteil }] of arbeitskostenJeSatz(lines, discount)) {
    total += priceMode === "netto" ? anteil + taxOf(anteil, rate) : anteil;
  }
  return total;
}

/**
 * Je Steuersatz der Anteil der gekennzeichneten Positionen und die Summe aller Positionen, beide nach Positionsrabatt und
 * um ihren Anteil am Gesamtrabatt gemindert, im Preismodus der Positionen (ohne Steuer bei Nettopreisen).
 * Abzugspositionen zählen nicht mit.
 */
export function arbeitskostenJeSatz(lines: ArbeitskostenLine[], discount: Discount | null = null): Map<BasisPoints, { anteil: Cents; summe: Cents }> {
  const basis = discountBasis(lines);
  const reductions = splitDocumentDiscount(lines, discount);
  const result = new Map<BasisPoints, { anteil: Cents; summe: Cents }>();
  for (const [rate, sum] of basis) {
    const reduction = reductions.get(rate) ?? 0;
    const marked = lines
      .filter((line) => line.taxRate === rate && line.arbeitskosten && !line.deductionOf)
      .reduce((s, line) => s + discountedLineAmount(line), 0);
    // Wie bisher: ohne Summe des Satzes kein Anteil, ohne Gesamtrabatt die gekennzeichneten Positionen unverändert
    const anteil = marked === 0 || sum === 0 ? 0 : reduction === 0 ? marked : marked - roundHalfAwayFromZero((reduction * marked) / sum);
    result.set(rate, { anteil, summe: sum - reduction });
  }
  return result;
}

/**
 * Teil eines Betrags, der auf Arbeits-, Maschinen- und Fahrtkosten entfällt, im Verhältnis anteil zu summe eines
 * Steuersatzes, kaufmännisch gerundet. Für Abschläge aus dem Zahlungsplan: Das BMF-Schreiben lässt eine prozentuale
 * Aufteilung durch den Rechnungsaussteller zu (Rz. 40), Abschlagszahlungen zählen nur mit eigener Rechnung, die den
 * Anteil nennt (#1667)
 */
export function arbeitskostenTeil(betrag: Cents, { anteil, summe }: { anteil: Cents; summe: Cents }): Cents {
  if (summe === 0 || anteil === 0) return 0;
  if (anteil === summe) return betrag;
  return roundHalfAwayFromZero((betrag * anteil) / summe);
}
