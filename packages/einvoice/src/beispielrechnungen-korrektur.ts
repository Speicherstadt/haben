// Beispielrechnungen zur Korrektur, deren Steuer aus dem Gesamtstand folgt (#2079); Teil von BEISPIELRECHNUNGEN
import { computeInvoice, correctionCalculation } from "@haben/core";
import { sampleDocument } from "./samples.ts";
import type { InvoiceDocument } from "./types.ts";

/**
 * Korrektur über einen kleinen Teil einer Rechnung, Steuer aus dem Gesamtstand (#2079). netto: Rechnung 100,00 €, Korrektur
 * −0,50 €, Steuer −0,09 € (Stand 99,50 € → 18,91 €). brutto: Rechnung 1,01 € (0,16 € Steuer), Korrektur −0,10 €, Steuer
 * −0,01 € (Stand 0,91 € → 0,15 €) und Netto −0,09 €.
 */
function korrekturAusGesamtstand(format: InvoiceDocument["format"], priceMode: "netto" | "brutto"): InvoiceDocument {
  const [original, part] = priceMode === "netto" ? [10_000, 50] : [101, 10];
  const line = { description: "Gutschrift Beratung", quantity: 1000, unit: "Psch." as const, unitPrice: part, taxRate: 1900 as const };
  const doc = sampleDocument({ kind: "korrektur", format, lines: [line], priceMode });
  const sealed = computeInvoice([{ ...line, unitPrice: original }], priceMode).totals.taxes;
  const inputs = [{ ...line, unitPrice: -part }];
  const { totals, lineNets } = correctionCalculation(computeInvoice(inputs, priceMode), inputs, priceMode, sealed);
  return { ...doc, totals, lines: doc.lines.map((l, i) => ({ ...l, net: lineNets[i]! })) };
}

/** 0,09 € auf 0,50 € statt 0,10 €: BR-CO-17 und BR-S-09 lassen eine Abweichung unter einer Währungseinheit zu */
export const KORREKTUREN_AUS_GESAMTSTAND: Record<string, InvoiceDocument> = Object.fromEntries(
  (["zugferd", "xrechnung-cii", "xrechnung-ubl"] as const).flatMap((format) => [
    [`korrektur-gesamtstand-${format}`, korrekturAusGesamtstand(format, "netto")],
    [`korrektur-gesamtstand-brutto-${format}`, korrekturAusGesamtstand(format, "brutto")],
  ]),
);
