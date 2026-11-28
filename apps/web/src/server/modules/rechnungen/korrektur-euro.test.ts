import { computeInvoice, foreignToEuro } from "@haben/core";
import { describe, expect, it, vi } from "vitest";

// Nur die Rechnung, ohne Datenbank
vi.mock("../../db/index.ts", () => {
  const ersatz: unknown = new Proxy(() => {}, { get: () => ersatz, apply: () => ersatz });
  return { db: ersatz, schema: ersatz };
});

const { correctionTaxes, euroTaxes } = await import("./invoice-taxes.ts");

type Line = { quantity: number; unitPrice: number; taxRate: 1900 | 700 };
const line = (unitPrice: number, taxRate: Line["taxRate"] = 1900): Line => ({ quantity: 1000, unitPrice, taxRate });

/** Gesamtstand einer festgeschriebenen Rechnung in Fremdwährung, wie euroTaxes ihn bucht */
function basisOf(lines: Line[], rate: string) {
  const document = computeInvoice(lines).totals.taxes;
  return { document, euro: euroTaxes(document, "GBP", rate).map(({ rate: r, base, tax }) => ({ rate: r, base, tax })) };
}

describe("Korrektur in Fremdwährung: Euro aus dem Gesamtstand (#2079)", () => {
  it("100,00 GBP mit −0,50 und −99,50 GBP: auch in Euro genau die gebuchte Steuer zurück", () => {
    const basis = basisOf([line(10_000)], "0.85");
    expect(basis.euro).toEqual([{ rate: 1900, base: 11_765, tax: 2_235 }]);
    const lines = [line(-50)];
    const a = correctionTaxes(computeInvoice(lines), lines, "netto", basis, "GBP", "0.85").taxes;
    // Stand 99,50 GBP = 117,06 €, 18,91 GBP = 22,25 €; je Beleg wären es −0,11 €
    expect(a).toEqual([{ rate: 1900, base: -59, tax: -10, originalBase: -50, originalTax: -9 }]);
    const after = {
      document: [{ rate: 1900, base: 9_950, tax: 1_891 }],
      euro: [{ rate: 1900, base: 11_765 - 59, tax: 2_235 - 10 }],
    };
    const restLines = [line(-9_950)];
    const b = correctionTaxes(computeInvoice(restLines), restLines, "netto", after, "GBP", "0.85").taxes;
    expect(b).toEqual([{ rate: 1900, base: -11_706, tax: -2_225, originalBase: -9_950, originalTax: -1_891 }]);
  });

  it("entgegengesetzte Vorzeichen der Gesamtsteuer in Belegwährung und Euro: je Beleg umgerechnet (PEPPOL-EN16931-R055)", () => {
    // 100,00 CNY zu 19 % und 100,00 CNY zu 7 %, Kurs 7,5; Korrektur +2,03 CNY zu 19 %, −5,65 CNY zu 7 %
    const basis = basisOf([line(10_000), line(10_000, 700)], "7.5");
    const lines = [line(203), line(-565, 700)];
    const own = computeInvoice(lines);
    const { calculation, taxes } = correctionTaxes(own, lines, "netto", basis, "GBP", "7.5");
    const documentTax = calculation.totals.tax;
    const euroTax = taxes.reduce((s, t) => s + t.tax, 0);
    // Stand 19 %: 102,03 → 19,39 (+0,39), 7 %: 94,35 → 6,60 (−0,40); in Euro aus dem Gesamtstand +0,06 € und −0,05 €
    expect(documentTax).toBe(-1);
    // Aus dem Gesamtstand wären es +0,01 €; je Beleg umgerechnet hat die Steuer dasselbe Vorzeichen
    expect(euroTax).toBeLessThanOrEqual(0);
    expect(taxes).toEqual(euroTaxes(calculation.totals.taxes, "GBP", "7.5"));
    expect(taxes.map((t) => t.tax)).toEqual(calculation.totals.taxes.map((t) => foreignToEuro(t.tax, "7.5")));
  });
});
