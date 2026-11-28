import { describe, expect, it } from "vitest";
import { allocateSplitTax, type DocumentSplitLine } from "./document-split.ts";
import { PRIVATENTNAHME } from "./kontenplan.ts";
import { belegPrivat, betrieblichSteuer } from "./beleg-anteile.ts";
import { computeEuer, type EuerPayment, type EuerResult } from "./euer.ts";
import { paidTaxShares } from "./posting.ts";

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

  it("Bewirtung auf zwei eigenen Sachkonten: je Konto zu 70 %, wie im Journal", () => {
    const t = { net: 11_002, tax: 2_090, gross: 13_092, taxes: [{ rate: 1900, base: 11_002, tax: 2_090 }] };
    const euer = computeEuer(2026, [
      payment({
        totals: t,
        paid: t.gross,
        category: "bewirtung",
        splits: zeilen(
          [
            { category: "bewirtung", taxRate: 1900, net: 7_501, account: "4651" },
            { category: "bewirtung", taxRate: 1900, net: 2_501, account: "4652" },
            { category: PRIVATENTNAHME, taxRate: 1900, net: 1_000 },
          ],
          t,
        ),
      }),
    ]);
    // 52,51 € + 17,51 € (je 70 % von 75,01 € und 25,01 €)
    expect(amount(euer, "ausgabe:bewirtung")).toBe(7_002);
  });

  it("Bewirtung mit Teilabzug: Netto und nicht abziehbare Vorsteuer stehen im Journal getrennt und runden getrennt", () => {
    const t = { net: 11_002, tax: 2_090, gross: 13_092, taxes: [{ rate: 1900, base: 11_002, tax: 2_090, vorsteuerAnteil: 9_970 }] };
    const lines = zeilen(
      [
        { category: "bewirtung", taxRate: 1900, net: 7_501 },
        { category: "bewirtung", taxRate: 1900, net: 2_501 },
        { category: PRIVATENTNAHME, taxRate: 1900, net: 1_000 },
      ],
      t,
    );
    const euer = computeEuer(2026, [payment({ totals: t, paid: t.gross, category: "bewirtung", splits: lines })]);
    // Betrieb 19,00 € Steuer, davon 99,7 % = 18,94 € abziehbar, 0,06 € nicht: 70 % von 100,02 € und von 0,06 € je gerundet
    expect(amount(euer, "vorsteuer")).toBe(1_894);
    expect(amount(euer, "ausgabe:bewirtung")).toBe(7_001 + 4);
  });

  it("Bewirtung zu 0 % und ohne Vorsteuerabzug: beide stehen im Journal unter keineVSt und runden zusammen", () => {
    const t = {
      net: 11_781,
      tax: 420,
      gross: 12_201,
      taxes: [
        { rate: 0, base: 7_502, tax: 0 },
        { rate: 700, base: 3_279, tax: 230, vorsteuerAnteil: 0 },
        { rate: 1900, base: 1_000, tax: 190 },
      ],
    };
    const lines: DocumentSplitLine[] = [
      { category: "bewirtung", taxRate: 0, net: 7_502 },
      { category: "bewirtung", taxRate: 700, net: 3_279 },
      { category: PRIVATENTNAHME, taxRate: 1900, net: 1_000 },
    ];
    const splits = allocateSplitTax(
      lines,
      t.taxes.map((r) => ({ taxRate: r.rate, net: r.base, tax: r.tax })),
    );
    const euer = computeEuer(2026, [payment({ totals: t, paid: t.gross, category: "bewirtung", splits })]);
    // 75,02 € + 35,09 € (32,79 € + 2,30 € nicht abziehbar) = 110,11 €, davon 70 %
    expect(amount(euer, "ausgabe:bewirtung")).toBe(7_708);
  });

  it("Teilzahlung mit Teilabzug: eine Bewirtungszeile zu 0 % rundet als eine Journalzeile, auch wenn ein Steuercent auf sie fällt", () => {
    const t = {
      net: 13_000,
      tax: 640,
      gross: 13_640,
      taxes: [
        { rate: 0, base: 9_000, tax: 0, vorsteuerAnteil: 3_000 },
        { rate: 1900, base: 3_000, tax: 570, vorsteuerAnteil: 3_000 },
        { rate: 700, base: 1_000, tax: 70, vorsteuerAnteil: 3_000 },
      ],
    };
    const lines: DocumentSplitLine[] = [
      { category: "bewirtung", taxRate: 0, net: 9_000 },
      { category: "telefon", taxRate: 1900, net: 2_000 },
      { category: PRIVATENTNAHME, taxRate: 1900, net: 1_000 },
      { category: "buero", taxRate: 700, net: 1_000 },
    ];
    const splits = allocateSplitTax(
      lines,
      t.taxes.map((r) => ({ taxRate: r.rate, net: r.base, tax: r.tax })),
    );
    const falsch: number[] = [];
    for (let paid = 1; paid <= t.gross; paid += 1) {
      const euer = computeEuer(2026, [payment({ totals: t, paid, category: "bewirtung", splits })]);
      // Eine Bewirtungszeile, eine Journalzeile: 70 % auf ihren ganzen Aufwand
      const aufwand = amount(euer, "ausgabe:bewirtung") + euer.bewirtungNichtAbziehbar;
      if (amount(euer, "ausgabe:bewirtung") !== Math.round((aufwand * 7) / 10)) falsch.push(paid);
    }
    expect(falsch).toEqual([]);
  });

  it("Teilzahlung: Vorsteuer der EÜR wie in der Voranmeldung (betrieblichSteuer)", () => {
    const t = { net: 1_000, tax: 190, gross: 1_190, taxes: [{ rate: 1900, base: 1_000, tax: 190 }] };
    const splits = zeilen(
      [
        { category: "telefon", taxRate: 1900, net: 887 },
        { category: PRIVATENTNAHME, taxRate: 1900, net: 113 },
      ],
      t,
    );
    const falsch: number[] = [];
    for (let paid = 1; paid <= t.gross; paid++) {
      const gezahlt = paidTaxShares(t, paid)[0]!.tax;
      const ustva = betrieblichSteuer(belegPrivat(0, splits), 1900, gezahlt, t.tax);
      if (amount(computeEuer(2026, [payment({ totals: t, paid, splits })]), "vorsteuer") !== ustva) falsch.push(paid);
    }
    expect(falsch).toEqual([]);
  });

  it("Teilzahlung mit zwei betrieblichen Zeilen und 50 % Entnahme: Aufwand wie beim Privatanteil am Beleg", () => {
    const splits = zeilen([
      { category: "internet", taxRate: 1900, net: 2_500 },
      { category: "telefon", taxRate: 1900, net: 2_500 },
      { category: PRIVATENTNAHME, taxRate: 1900, net: 5_000 },
    ]);
    const falsch: number[] = [];
    for (let paid = 1; paid <= totals.gross; paid += 3) {
      const aufteilung = computeEuer(2026, [payment({ paid, splits })]);
      const privatanteil = computeEuer(2026, [payment({ paid, privateShare: 50 })]);
      const aufwand = amount(aufteilung, "ausgabe:internet") + amount(aufteilung, "ausgabe:telefon") + amount(aufteilung, "vorsteuer");
      if (aufwand !== amount(privatanteil, "ausgabe:telefon") + amount(privatanteil, "vorsteuer")) falsch.push(paid);
    }
    expect(falsch).toEqual([]);
  });

  it("Teilzahlung mit steuerfreier Entnahmezeile: nicht mehr Vorsteuer als gezahlte Steuer", () => {
    const t = {
      net: 17_000,
      tax: 1_160,
      gross: 18_160,
      taxes: [
        { rate: 1900, base: 5_000, tax: 950 },
        { rate: 700, base: 3_000, tax: 210 },
        { rate: 0, base: 9_000, tax: 0 },
      ],
    };
    const splits = allocateSplitTax(
      [
        { category: "telefon", taxRate: 1900, net: 5_000 },
        { category: "buero", taxRate: 700, net: 3_000 },
        { category: PRIVATENTNAHME, taxRate: 0, net: 9_000 },
      ],
      t.taxes.map((r) => ({ taxRate: r.rate, net: r.base, tax: r.tax })),
    );
    expect(amount(computeEuer(2026, [payment({ totals: t, paid: 1_100, splits })]), "vorsteuer")).toBe(70);
  });
});
