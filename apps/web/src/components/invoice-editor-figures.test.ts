import { describe, expect, it } from "vitest";
import { previewTotalsOf } from "./invoice-editor-figures.ts";

describe("Summen im Editor einer Rechnungskorrektur (#2079)", () => {
  const line = (unitPrice: number) => ({ quantity: 1000, unitPrice, taxRate: 1900 as const });

  it("zeigt die Steuer aus dem Gesamtstand, wie sie festgeschrieben wird, auch im Dialog „Festschreiben“", () => {
    // Rechnung 100,00 €: −0,50 € für sich −0,10 € Steuer, auf dem Stand 99,50 € → 18,91 € nur −0,09 €
    const basis = [{ rate: 1900, base: 10_000, tax: 1_900 }];
    expect(previewTotalsOf([line(-50)], "netto", null, basis)).toMatchObject({ net: -50, tax: -9, gross: -59 });
  });

  it("rechnet ohne Gesamtstand (Rechnung, Angebot) wie bisher", () => {
    expect(previewTotalsOf([line(-50)], "netto", null, null)).toMatchObject({ net: -50, tax: -10, gross: -60 });
  });
});
