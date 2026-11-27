import { describe, expect, it } from "vitest";
import { allocateSplitTax, type DocumentSplitLine } from "./document-split.ts";
import { PRIVATENTNAHME } from "./kontenplan.ts";
import { computeEuer, type EuerPayment, type EuerResult } from "./euer.ts";

/*
 * EÜR eines Belegs mit Entnahmezeile (#1975) gegen denselben Beleg mit Privatanteil am Beleg: Die Entnahme trägt ihren
 * kaufmännisch gerundeten Anteil, der Betrieb den Rest, auch für einen Teil des Zahlbetrags.
 */

const amount = (euer: EuerResult, key: string) => [...euer.einnahmen, ...euer.ausgaben].find((l) => l.key === key)?.amount ?? 0;
const totals = { net: 10_000, tax: 1_900, gross: 11_900, taxes: [{ rate: 1900, base: 10_000, tax: 1_900 }] };
const zeilen = (lines: DocumentSplitLine[], t = totals) => allocateSplitTax(lines, [{ taxRate: 1900, net: t.net, tax: t.tax }]);
const payment = (extra: object): EuerPayment => ({ kind: "document", date: "2026-09-15", paid: 11_900, totals, category: "telefon", ...extra });

describe("EÜR mit Entnahmezeile (#1975)", () => {
  it.each([6_000, 3_966, 11_900])("Zahlung %i ct: Vorsteuer und Aufwand wie beim Privatanteil am Beleg", (paid) => {
    const aufteilung = computeEuer(2026, [
      payment({
        paid,
        splits: zeilen([
          { category: "telefon", taxRate: 1900, net: 7_500 },
          { category: PRIVATENTNAHME, taxRate: 1900, net: 2_500 },
        ]),
      }),
    ]);
    const privatanteil = computeEuer(2026, [payment({ paid, privateShare: 25 })]);
    expect(amount(aufteilung, "vorsteuer")).toBe(amount(privatanteil, "vorsteuer"));
    expect(amount(aufteilung, "ausgabe:telefon")).toBe(amount(privatanteil, "ausgabe:telefon"));
  });

  it("Bewirtung: zwei Zeilen desselben Kontos und Satzes zählen zusammen zu 70 %, wie im Journal", () => {
    const t = { net: 11_002, tax: 2_090, gross: 13_092, taxes: [{ rate: 1900, base: 11_002, tax: 2_090 }] };
    const euer = computeEuer(2026, [
      payment({
        totals: t,
        paid: t.gross,
        category: "bewirtung",
        splits: zeilen(
          [
            { category: "bewirtung", taxRate: 1900, net: 7_501 },
            { category: "bewirtung", taxRate: 1900, net: 2_501 },
            { category: PRIVATENTNAHME, taxRate: 1900, net: 1_000 },
          ],
          t,
        ),
      }),
    ]);
    // 100,02 € Bewirtung, davon 70 % kaufmännisch gerundet
    expect(amount(euer, "ausgabe:bewirtung")).toBe(7_001);
  });
});
