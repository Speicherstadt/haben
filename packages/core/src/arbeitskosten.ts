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
  const basis = discountBasis(lines);
  const reductions = splitDocumentDiscount(lines, discount);
  let total = 0;
  for (const [rate, sum] of basis) {
    const marked = lines
      .filter((line) => line.taxRate === rate && line.arbeitskosten && !line.deductionOf)
      .reduce((s, line) => s + discountedLineAmount(line), 0);
    if (marked === 0 || sum === 0) continue;
    const reduction = reductions.get(rate) ?? 0;
    const amount = reduction === 0 ? marked : marked - roundHalfAwayFromZero((reduction * marked) / sum);
    total += priceMode === "netto" ? amount + taxOf(amount, rate) : amount;
  }
  return total;
}
