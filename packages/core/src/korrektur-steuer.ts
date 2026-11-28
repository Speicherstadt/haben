import type { InvoiceCalculation, PriceMode, TaxBreakdown } from "./invoice.ts";
import { taxIncluded, taxOf, type BasisPoints } from "./money.ts";

/**
 * Steuer je Satz einer Rechnungskorrektur aus der Differenz der Gesamtstände (#2079): Steuer(Stand nach der Korrektur)
 * − Steuer, wie sie auf den festgeschriebenen Belegen steht (Rechnung und ihre Korrekturen, `sealed`). Gerundet wird nur
 * der Gesamtstand, nie die Differenz. So nehmen mehrere Korrekturen zusammen genau die Steuer der Rechnung zurück, die
 * § 17 Abs. 1 UStG berichtigt („dafür geschuldeter Steuerbetrag“), statt je Beleg gerundet einen Cent mehr oder weniger.
 * Gerundet wird die Steuer der Leistung, nicht die des Belegs (Abschn. 14.5 Abs. 20 UStAE: „für die von ihm ausgeführte
 * steuerpflichtige Leistung nach Cent genau berechnet“); so entschieden in #2080, auch wenn der einzelne Korrekturbeleg
 * dann von seinem Netto × Satz abweicht.
 *
 * netto: Die Bemessungsgrundlage der Korrektur bleibt, die Steuer folgt aus dem Netto-Gesamtstand.
 * brutto: Der Bruttobetrag der Korrektur bleibt (er steht in den Preisen), die Steuer wird aus dem Brutto-Gesamtstand
 * herausgerechnet und das Netto ist die Differenz. Die Abweichung trägt das Zeilennetto der betragsmäßig größten Zeile des
 * Satzes, wie den Rundungsrest in computeInvoice; der Abzug netto des Gesamtrabatts bleibt so gleich.
 *
 * Die Steuer weicht damit meist um einen Cent von Bemessungsgrundlage × Satz ab, nach älteren, je Beleg gerundeten
 * Korrekturen auch um mehr; EN 16931 lässt eine Abweichung unter einer Währungseinheit zu (BR-CO-17,
 * BR-S-09: Abweichung unter einer Währungseinheit). Ein Satz, den die Rechnung nicht hat, rechnet wie bisher für sich.
 * Die Steuer bleibt immer unter einer Währungseinheit von Bemessungsgrundlage × Satz; sonst gilt die eigene Rechnung.
 */
export function correctionCalculation(
  calculation: InvoiceCalculation,
  lines: { taxRate: BasisPoints }[],
  priceMode: PriceMode,
  sealed: TaxBreakdown[],
): InvoiceCalculation {
  const lineNets = [...calculation.lineNets];
  const taxes = calculation.totals.taxes.map((t) => {
    const before = sealed.find((s) => s.rate === t.rate) ?? { base: 0, tax: 0 };
    const gross = t.base + t.tax;
    const tax = priceMode === "netto" ? taxOf(before.base + t.base, t.rate) - before.tax : taxIncluded(before.base + before.tax + gross, t.rate) - before.tax;
    const base = priceMode === "netto" ? t.base : gross - tax;
    // Haben ältere, je Beleg gerundete Korrekturen über viele Belege mehr als eine Währungseinheit Abweichung angesammelt,
    // hielte diese Korrektur BR-CO-17 nicht mehr ein: dann rechnet sie wie bisher für sich
    if (Math.abs(tax - taxOf(base, t.rate)) >= 100) return t;
    if (priceMode === "netto") return { ...t, tax };
    const shift = base - t.base;
    if (shift !== 0) {
      const indexes = lines.map((line, i) => (line.taxRate === t.rate ? i : -1)).filter((i) => i >= 0);
      const amounts = calculation.lineAmounts;
      const largest = indexes.reduce((best, i) => (Math.abs(amounts[i]!) > Math.abs(amounts[best]!) ? i : best), indexes[0]!);
      lineNets[largest] = lineNets[largest]! + shift;
    }
    return { ...t, base, tax };
  });
  const net = taxes.reduce((sum, t) => sum + t.base, 0);
  const tax = taxes.reduce((sum, t) => sum + t.tax, 0);
  return { ...calculation, totals: { net, tax, gross: net + tax, taxes }, lineNets };
}
