import { describe, expect, it } from "vitest";
import { paidTaxShares, settlementTaxShares, type TaxShare } from "./steueranteile.ts";

/*
 * Der Steuer-Rundungsrest darf nur auf Sätze fallen, die überhaupt Steuer tragen (#2026). Vorher nahm ihn der größte
 * Basisposten, auch ein 0-%-Satz; dort verwarf ihn die Ausgleichsbuchung, und der Saldo-Trigger lehnte die Buchung ab.
 * Alle Beträge sind erfunden.
 */

/** Netto und Steuer je Satz, dazu die Summen wie in InvoiceTotals */
function totals(rows: { rate: 1900 | 700 | 0; base: number; tax: number }[]) {
  const net = rows.reduce((s, r) => s + r.base, 0);
  const tax = rows.reduce((s, r) => s + r.tax, 0);
  return { net, tax, gross: net + tax, taxes: rows };
}

const summe = (rows: TaxShare[]) => ({
  base: rows.reduce((s, r) => s + r.base, 0),
  tax: rows.reduce((s, r) => s + r.tax, 0),
});

describe("paidTaxShares: Rundungsrest (#2026)", () => {
  /*
   * 50 € zu 19 %, 30 € zu 7 %, 90 € zu 0 %, Teilzahlung 11 €.
   * Einzeln gerundet: Steuer 58 + 13 + 0 = 71 ct, der Gesamtanteil ist aber 70 ct. Der Rest von −1 ct landete bisher
   * auf der 90-€-Zeile zu 0 %, die damit −1 ct Steuer trug.
   */
  const beleg = totals([
    { rate: 1900, base: 5_000, tax: 950 },
    { rate: 700, base: 3_000, tax: 210 },
    { rate: 0, base: 9_000, tax: 0 },
  ]);

  it("lässt einen Satz ohne Steuer ohne Steuer, auch wenn er der größte Posten ist", () => {
    const anteile = paidTaxShares(beleg, 1_100);
    const ohneSteuer = anteile.find((a) => a.rate === 0)!;
    expect(ohneSteuer.tax).toBe(0);
    expect(ohneSteuer.base).toBe(545);
  });

  it("verteilt den Steuer-Rest auf den größten Posten, der Steuer trägt", () => {
    const anteile = paidTaxShares(beleg, 1_100);
    expect(anteile.find((a) => a.rate === 1900)!.tax).toBe(57);
    expect(anteile.find((a) => a.rate === 700)!.tax).toBe(13);
  });

  it("trifft zusammen weiterhin genau den gezahlten Betrag und die gerundete Gesamtsteuer", () => {
    const anteile = paidTaxShares(beleg, 1_100);
    expect(summe(anteile)).toEqual({ base: 1_030, tax: 70 });
    expect(summe(anteile).base + summe(anteile).tax).toBe(1_100);
  });

  it("bleibt ohne 0-%-Satz beim bisherigen Verhalten", () => {
    const zwei = totals([
      { rate: 1900, base: 5_000, tax: 950 },
      { rate: 700, base: 3_000, tax: 210 },
    ]);
    // 11 € auf 9.160 € brutto: Steuer 139 ct, Netto 961 ct; einzeln 114 + 25 = 139, kein Steuer-Rest
    expect(summe(paidTaxShares(zwei, 1_100))).toEqual({ base: 961, tax: 139 });
  });

  it("gibt dem 0-%-Satz auch dann keinen Rest, wenn er den Netto-Rest trägt", () => {
    // 10 € zu 19 % (1,90 €) und 90 € zu 0 %, Zahlung 33,33 €: der Netto-Rest gehört auf den größten Posten,
    // der Steuer-Rest nicht, weil der 0-%-Satz keine Steuer hat
    const gemischt = totals([
      { rate: 1900, base: 1_000, tax: 190 },
      { rate: 0, base: 9_000, tax: 0 },
    ]);
    const anteile = paidTaxShares(gemischt, 3_333);
    expect(anteile.find((a) => a.rate === 0)!.tax).toBe(0);
    expect(summe(anteile).base + summe(anteile).tax).toBe(3_333);
  });

  it("trägt den Rest über Folgezahlungen weiter, nicht in die 0-%-Zeile", () => {
    const erste = paidTaxShares(beleg, 1_100);
    const zweite = settlementTaxShares(beleg, 1_100, erste, 2_000);
    expect(zweite.find((s) => s.rate === 0)!.tax).toBe(0);
    const zusammen = [...erste, ...zweite].reduce(
      (s, r) => ({ base: s.base + r.base, tax: s.tax + r.tax }),
      { base: 0, tax: 0 },
    );
    expect(zusammen).toEqual(summe(paidTaxShares(beleg, 3_100)));
  });
});
