import { describe, expect, it } from "vitest";
import { arbeitskostenAnteil, arbeitskostenJeSatz, arbeitskostenTeil, type ArbeitskostenLine } from "./arbeitskosten.ts";
import { computeInvoice } from "./invoice.ts";

// Beispiel aus #712: 3 Rauchwarnmelder je 31,00 € (Material), Montage 3 × 8,00 €, Anfahrt 35,00 € → Arbeit und Fahrt 59,00 €
const melder = (taxRate: 0 | 1900, brutto = false): ArbeitskostenLine[] => {
  const preis = (cents: number) => (brutto && taxRate === 1900 ? Math.round(cents * 1.19) : cents);
  return [
    { quantity: 3000, unitPrice: preis(3100), taxRate },
    { quantity: 3000, unitPrice: preis(800), taxRate, arbeitskosten: true },
    { quantity: 1000, unitPrice: preis(3500), taxRate, arbeitskosten: true },
  ];
};

describe("arbeitskostenAnteil (§ 35a EStG)", () => {
  it("ohne gekennzeichnete Position kein Anteil", () => {
    expect(arbeitskostenAnteil([{ quantity: 1000, unitPrice: 5000, taxRate: 1900 }], "netto")).toBeNull();
    expect(arbeitskostenAnteil([], "netto")).toBeNull();
  });

  it("Kleinunternehmer: Summe der Positionen für Arbeit und Fahrt", () => {
    expect(arbeitskostenAnteil(melder(0), "netto")).toBe(5900);
  });

  it("Nettopreise: brutto mit der Steuer des Satzes, Bruttopreise wie eingegeben", () => {
    expect(arbeitskostenAnteil(melder(1900), "netto")).toBe(5900 + 1121);
    // 8,00 € netto = 9,52 € brutto, 35,00 € = 41,65 €: 3 × 9,52 + 41,65
    expect(arbeitskostenAnteil(melder(1900, true), "brutto")).toBe(3 * 952 + 4165);
  });

  it("Positionsrabatt und Gesamtrabatt mindern den Anteil wie die Summe", () => {
    const lines = melder(0).map((l) => (l.arbeitskosten ? { ...l, discount: { kind: "prozent" as const, value: 1000 } } : l));
    expect(arbeitskostenAnteil(lines, "netto")).toBe(5310);
    // 10 % Gesamtrabatt auf 152,00 €: der Anteil sinkt im selben Verhältnis
    expect(arbeitskostenAnteil(melder(0), "netto", { kind: "prozent", value: 1000 })).toBe(5310);
    // Fester Rabatt 15,20 € von 152,00 €, also 10 %
    expect(arbeitskostenAnteil(melder(0), "netto", { kind: "betrag", value: 1520 })).toBe(5310);
    // Gesamtrabatt in Höhe der Summe ergibt 0
    const total = computeInvoice(melder(0)).totals.gross;
    expect(arbeitskostenAnteil(melder(0), "netto", { kind: "betrag", value: total })).toBe(0);
  });

  it("je Steuersatz getrennt; Abzugspositionen der Schlussrechnung zählen nicht", () => {
    const lines: ArbeitskostenLine[] = [
      { quantity: 1000, unitPrice: 10_000, taxRate: 1900, arbeitskosten: true },
      { quantity: 1000, unitPrice: 5000, taxRate: 700, arbeitskosten: true },
      { quantity: 1000, unitPrice: -2000, taxRate: 1900, arbeitskosten: true, deductionOf: "abschlag" },
    ];
    expect(arbeitskostenAnteil(lines, "netto")).toBe(11_900 + 5350);
  });

  it("Storno: negierte Positionen ergeben den negierten Anteil", () => {
    const storno = melder(1900).map((l) => ({ ...l, unitPrice: -l.unitPrice }));
    expect(arbeitskostenAnteil(storno, "netto")).toBe(-(5900 + 1121));
  });
});

describe("Anteil je Steuersatz und Teil eines Abschlags (#1667)", () => {
  // Zu 19 %: Fliesen 4.000 € und Verlegen 6.000 € (Arbeit); zu 7 %: Material 1.000 € und Arbeit 1.000 €
  const auftrag: ArbeitskostenLine[] = [
    { quantity: 1000, unitPrice: 400_000, taxRate: 1900 },
    { quantity: 1000, unitPrice: 600_000, taxRate: 1900, arbeitskosten: true },
    { quantity: 1000, unitPrice: 100_000, taxRate: 700 },
    { quantity: 1000, unitPrice: 100_000, taxRate: 700, arbeitskosten: true },
  ];

  it("je Satz Anteil und Summe nach Gesamtrabatt, im Preismodus der Positionen", () => {
    expect(arbeitskostenJeSatz(auftrag)).toEqual(
      new Map([
        [1900, { anteil: 600_000, summe: 1_000_000 }],
        [700, { anteil: 100_000, summe: 200_000 }],
      ]),
    );
    expect(arbeitskostenJeSatz(auftrag, { kind: "prozent", value: 1000 })).toEqual(
      new Map([
        [1900, { anteil: 540_000, summe: 900_000 }],
        [700, { anteil: 90_000, summe: 180_000 }],
      ]),
    );
  });

  it("Satz ohne gekennzeichnete Position mit Anteil 0", () => {
    expect(arbeitskostenJeSatz([{ quantity: 1000, unitPrice: 5000, taxRate: 700 }]).get(700)).toEqual({ anteil: 0, summe: 5000 });
  });

  it("Teil eines Abschlags im Verhältnis des Satzes, kaufmännisch gerundet", () => {
    expect(arbeitskostenTeil(270_000, { anteil: 540_000, summe: 900_000 })).toBe(162_000);
    // 1.000,01 € × 1 / 3 = 333,336… → 333,34 €
    expect(arbeitskostenTeil(100_001, { anteil: 1, summe: 3 })).toBe(33_334);
    expect(arbeitskostenTeil(-270_000, { anteil: 540_000, summe: 900_000 })).toBe(-162_000);
  });

  it("ganz Arbeit, ganz Material oder ohne Summe", () => {
    expect(arbeitskostenTeil(12_345, { anteil: 500, summe: 500 })).toBe(12_345);
    expect(arbeitskostenTeil(12_345, { anteil: 0, summe: 500 })).toBe(0);
    expect(arbeitskostenTeil(12_345, { anteil: 0, summe: 0 })).toBe(0);
  });
});
