import { describe, expect, it } from "vitest";
import { allocateSplitTax, documentSplitPosting, splitIssues, type DocumentSplitLine } from "./document-split.ts";
import { totalsFromTaxes } from "./invoice.ts";

/*
 * Privatentnahme als Zeile einer Aufteilung (#1975). Beispiel aus dem Issue: Telefon und Internet auf einer Rechnung,
 * 42,13 € netto und 8,01 € Vorsteuer (50,14 € brutto). Internet 33,60 € netto zu 25 % privat, Telefon 8,53 € netto zu
 * 40 % privat. Danach: 30,32 € Aufwand, 5,76 € Vorsteuer, 14,06 € Entnahme (11,81 € netto, 2,25 € Steuer).
 */

const ARBEIT = {
  SKR03: { internet: "4925", telefon: "4920", entnahme: "1800", vorsteuer: "1576", verbindlichkeiten: "1600" },
  SKR04: { internet: "6810", telefon: "6805", entnahme: "2100", vorsteuer: "1406", verbindlichkeiten: "3300" },
} as const;

const telefonNetto = 4_213;
const telefonSteuer = 801;
const telefonBrutto = 5_014;
const telefonLines: DocumentSplitLine[] = [
  { category: "internet", taxRate: 1900, net: 2_520 },
  { category: "privatentnahme", taxRate: 1900, net: 840 },
  { category: "telefon", taxRate: 1900, net: 512 },
  { category: "privatentnahme", taxRate: 1900, net: 341 },
];
const telefonAmounts = [{ taxRate: 1900, net: telefonNetto, tax: telefonSteuer }];
const telefonTotals = totalsFromTaxes([{ rate: 1900, base: telefonNetto, tax: telefonSteuer }]);
const sumOf = (werte: number[]) => werte.reduce((s, w) => s + w, 0);

describe("allocateSplitTax mit Privatentnahme", () => {
  it("teilt die Steuer des Satzes zuerst zwischen Betrieb und Entnahme, dann innerhalb der Gruppen", () => {
    const allocated = allocateSplitTax(telefonLines, telefonAmounts);
    // Entnahme 11,81 € netto trägt 2,25 € Steuer, der Betrieb 30,32 € netto die restlichen 5,76 €
    expect(allocated.map((l) => l.tax)).toEqual([479, 160, 97, 65]);
    expect(sumOf(allocated.filter((l) => l.category === "privatentnahme").map((l) => l.tax))).toBe(225);
    expect(sumOf(allocated.map((l) => l.tax))).toBe(telefonSteuer);
  });

  it("hängt nicht von der Reihenfolge ab: fünf Zeilen zu 3 ct, die Entnahme trägt 1 ct", () => {
    const betrieb: DocumentSplitLine[] = Array.from({ length: 4 }, () => ({ category: "sonstiges", taxRate: 1900, net: 3 }));
    const entnahme: DocumentSplitLine = { category: "privatentnahme", taxRate: 1900, net: 3 };
    for (const lines of [
      [entnahme, ...betrieb],
      [...betrieb, entnahme],
    ]) {
      const allocated = allocateSplitTax(lines, [{ taxRate: 1900, net: 15, tax: 3 }]);
      expect(sumOf(allocated.filter((l) => l.category === "privatentnahme").map((l) => l.tax))).toBe(1);
      expect(sumOf(allocated.filter((l) => l.category !== "privatentnahme").map((l) => l.tax))).toBe(2);
    }
  });

  it("spiegelt eine Gutschrift: Entnahme und Betrieb bleiben negativ", () => {
    const lines = telefonLines.map((l) => ({ ...l, net: -l.net }));
    const allocated = allocateSplitTax(lines, [{ taxRate: 1900, net: -telefonNetto, tax: -telefonSteuer }]);
    expect(sumOf(allocated.map((l) => l.tax))).toBe(-telefonSteuer);
    expect(allocated.filter((l) => l.category === "privatentnahme").every((l) => l.tax < 0)).toBe(true);
    expect(allocated.filter((l) => l.category !== "privatentnahme").every((l) => l.tax < 0)).toBe(true);
  });
});

describe("splitIssues mit Privatentnahme", () => {
  it("lässt eine Aufteilung mit mindestens einer betrieblichen Zeile zu", () => {
    expect(splitIssues(allocateSplitTax(telefonLines, telefonAmounts), telefonAmounts)).toEqual([]);
  });

  it("weist eine Aufteilung aus lauter Privatentnahmen ab", () => {
    const lines: DocumentSplitLine[] = [
      { category: "privatentnahme", taxRate: 1900, net: 100 },
      { category: "privatentnahme", taxRate: 1900, net: 200 },
    ];
    expect(splitIssues(allocateSplitTax(lines, [{ taxRate: 1900, net: 300, tax: 57 }]), [{ taxRate: 1900, net: 300, tax: 57 }])).toEqual([
      "Eine Aufteilung aus lauter Privatentnahmen hat keinen Betriebsanteil; für einen ganz privaten Beleg gilt der Privatanteil am Beleg",
    ]);
  });
});

describe("documentSplitPosting mit Privatentnahme", () => {
  for (const kontenrahmen of ["SKR03", "SKR04"] as const) {
    it(`${kontenrahmen}: Entnahme brutto auf das Entnahmekonto, Vorsteuer nur betrieblich`, () => {
      const k = ARBEIT[kontenrahmen];
      const lines = allocateSplitTax(telefonLines, telefonAmounts);
      const posting = documentSplitPosting(telefonTotals, lines, kontenrahmen, "einzelunternehmen", "bank");
      expect(
        posting.map(({ account, debit, credit, taxCode }) => ({ account, debit, credit, taxCode })).sort((a, b) => a.account.localeCompare(b.account)),
      ).toEqual(
        [
          { account: k.entnahme, debit: 1_406, credit: 0, taxCode: "keineVSt" },
          { account: k.internet, debit: 2_520, credit: 0, taxCode: "VSt19" },
          { account: k.telefon, debit: 512, credit: 0, taxCode: "VSt19" },
          { account: k.verbindlichkeiten, debit: 0, credit: telefonBrutto, taxCode: null },
          { account: k.vorsteuer, debit: 576, credit: 0, taxCode: "VSt19" },
        ].sort((a, b) => a.account.localeCompare(b.account)),
      );
      expect(sumOf(posting.map((l) => l.debit))).toBe(sumOf(posting.map((l) => l.credit)));
    });
  }

  it("weist die Entnahme in einer Kapitalgesellschaft ab", () => {
    const lines = allocateSplitTax(telefonLines, telefonAmounts);
    expect(() => documentSplitPosting(telefonTotals, lines, "SKR03", "gmbh", "bank")).toThrow(
      "Privatentnahmen gibt es nur im Einzelunternehmen; GmbH und UG kennen kein Privat",
    );
  });

  it("§ 13b: die Entnahme trägt Netto und Steuer mit dem Steuerschlüssel, Vorsteuer nur für den Betrieb (#542)", () => {
    const lines = allocateSplitTax(
      [
        { category: "software", taxRate: 1900, net: 1_000 },
        { category: "privatentnahme", taxRate: 1900, net: 200 },
      ],
      [{ taxRate: 1900, net: 1_200, tax: 228 }],
    );
    // Bei § 13b wird nur netto gezahlt; die Steuer geht ans Finanzamt
    const totals = { net: 1_200, tax: 228, gross: 1_200, taxes: [{ rate: 1900, base: 1_200, tax: 228 }] };
    const posting = documentSplitPosting(totals, lines, "SKR03", "einzelunternehmen", "bank", true, "eu");
    const byKonto = new Map(posting.map((l) => [`${l.account}|${l.taxCode}`, l.debit]));
    expect(byKonto.get("4964|RC13bEU")).toBe(1_000);
    expect(byKonto.get("1800|RC13bEU")).toBe(200);
    expect(byKonto.get("1800|keineVSt")).toBe(38);
    expect(byKonto.get("1577|VSt13b")).toBe(190);
    expect(sumOf(posting.map((l) => l.debit))).toBe(sumOf(posting.map((l) => l.credit)));
  });
});
