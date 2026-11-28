import { describe, expect, it } from "vitest";
import { computeInvoice, type TaxBreakdown } from "./invoice.ts";
import { correctionCalculation } from "./korrektur-steuer.ts";

type Line = { quantity: number; unitPrice: number; taxRate: 1900 | 700 | 0 };
const line = (unitPrice: number, taxRate: Line["taxRate"] = 1900, quantity = 1000): Line => ({ quantity, unitPrice, taxRate });

/** Rechnet die Korrektur wie beim Festschreiben: eigene Positionen, Gesamtstand der festgeschriebenen Belege davor */
const correction = (lines: Line[], sealed: TaxBreakdown[], priceMode: "netto" | "brutto" = "netto") =>
  correctionCalculation(computeInvoice(lines, priceMode), lines, priceMode, sealed);

/** Gesamtstand nach der Korrektur, wie ihn die nächste Korrektur vorfindet */
const plus = (sealed: TaxBreakdown[], taxes: TaxBreakdown[]): TaxBreakdown[] => {
  const byRate = new Map(sealed.map((t) => [t.rate, { ...t }]));
  for (const t of taxes) {
    const row = byRate.get(t.rate) ?? { rate: t.rate, base: 0, tax: 0 };
    byRate.set(t.rate, { rate: t.rate, base: row.base + t.base, tax: row.tax + t.tax });
  }
  return [...byRate.values()];
};

describe("Steuer einer Rechnungskorrektur aus der Differenz der Gesamtstände (#2079)", () => {
  it("100,00 € mit −0,50 € und −99,50 €: zusammen genau −19,00 € Steuer", () => {
    const original = computeInvoice([line(10_000)]).totals.taxes;
    const a = correction([line(-50)], original);
    expect(a.totals).toMatchObject({ net: -50, tax: -9, gross: -59 });
    const b = correction([line(-9_950)], plus(original, a.totals.taxes));
    expect(b.totals).toMatchObject({ net: -9_950, tax: -1_891, gross: -11_841 });
    expect(a.totals.tax + b.totals.tax).toBe(-1_900);
    expect(a.totals.gross + b.totals.gross).toBe(-11_900);
  });

  it("1,03 € mit −0,34 €, −0,34 € und −0,35 €: brutto bleibt nichts offen", () => {
    const original = computeInvoice([line(103)]).totals;
    expect(original).toMatchObject({ tax: 20, gross: 123 });
    let sealed = original.taxes;
    let gross = original.gross;
    for (const net of [-34, -34, -35]) {
      const c = correction([line(net)], sealed);
      sealed = plus(sealed, c.totals.taxes);
      gross += c.totals.gross;
    }
    expect(gross).toBe(0);
    expect(sealed).toEqual([{ rate: 1900, base: 0, tax: 0 }]);
  });

  it("ohne Rundung dazwischen wie bisher: dieselben Werte wie computeInvoice", () => {
    const original = computeInvoice([line(10_000), line(5_000, 700)]).totals.taxes;
    const lines = [line(-2_000), line(-1_000, 700)];
    expect(correction(lines, original)).toEqual(computeInvoice(lines));
  });

  it("die Steuer, wie sie auf den Belegen steht: eine vorher je Beleg gerundete Korrektur gleicht die nächste aus", () => {
    // Stand nach einer alten Korrektur −0,50 € mit −0,10 € Steuer: 99,50 € netto, 18,90 € Steuer
    const sealed = [{ rate: 1900, base: 9_950, tax: 1_890 }];
    expect(correction([line(-9_950)], sealed).totals).toMatchObject({ net: -9_950, tax: -1_890 });
  });

  it("ein Satz, den die Rechnung nicht hat, rechnet für sich", () => {
    const sealed = [{ rate: 1900, base: 10_000, tax: 1_900 }];
    expect(correction([line(-50), line(-50, 700)], sealed).totals.taxes).toEqual([
      { rate: 1900, base: -50, tax: -9 },
      { rate: 700, base: -50, tax: -4 },
    ]);
  });

  it("Bruttopreise: Steuer aus dem Gesamtstand brutto, Netto und Zeilennetto folgen", () => {
    // 1,01 € brutto: 0,85 € netto, 0,16 € Steuer
    const original = computeInvoice([line(101)], "brutto").totals.taxes;
    expect(original).toEqual([{ rate: 1900, base: 85, tax: 16 }]);
    // −0,10 € brutto für sich: −0,02 € Steuer; Stand danach 0,91 € brutto mit 0,15 € Steuer, also −0,01 €
    expect(computeInvoice([line(-10)], "brutto").totals).toMatchObject({ net: -8, tax: -2 });
    const c = correction([line(-10)], original, "brutto");
    expect(c.totals).toMatchObject({ net: -9, tax: -1, gross: -10 });
    expect(c.lineNets).toEqual([-9]);
    const rest = correction([line(-91)], plus(original, c.totals.taxes), "brutto");
    expect(rest.totals).toMatchObject({ net: -76, tax: -15, gross: -91 });
    expect(c.totals.tax + rest.totals.tax).toBe(-16);
  });

  it("Bruttopreise mit mehreren Zeilen: den Rest trägt die betragsmäßig größte, die Summe ergibt die Bemessungsgrundlage", () => {
    const sealed = [{ rate: 1900, base: 85, tax: 16 }];
    const lines = [line(-4), line(-6)];
    expect(computeInvoice(lines, "brutto").lineNets).toEqual([-3, -5]);
    const c = correction(lines, sealed, "brutto");
    expect(c.totals).toMatchObject({ net: -9, tax: -1, gross: -10 });
    expect(c.lineNets).toEqual([-3, -6]);
  });

  it("Gesamtrabatt: die Bemessungsgrundlage nach Rabatt zählt, der Abzug netto bleibt", () => {
    const lines = [line(-100)];
    const discount = { kind: "prozent" as const, value: 5000 };
    const sealed = [{ rate: 1900, base: 101, tax: 19 }];
    const own = computeInvoice(lines, "netto", discount);
    expect(own.totals).toMatchObject({ net: -50, tax: -10 });
    const c = correctionCalculation(own, lines, "netto", sealed);
    // Stand 0,51 € → 0,10 € (0,0969), also −0,09 €
    expect(c.totals).toMatchObject({ net: -50, tax: -9, gross: -59 });
    expect(c.allowances).toEqual(own.allowances);
  });
});
