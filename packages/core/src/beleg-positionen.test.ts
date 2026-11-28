import { describe, expect, it } from "vitest";
import {
  allocateSplitTax,
  betraegeAusPositionen,
  documentPosting,
  einzigeKontierung,
  positionenAusSaetzen,
  privatanteilDerPositionen,
  belegPrivat,
  type InvoiceTotals,
  type PostingLine,
} from "./index.ts";

const totals = (rows: { rate: number; base: number; tax: number; vorsteuerAnteil?: number }[], reverseCharge = false): InvoiceTotals => {
  const net = rows.reduce((s, r) => s + r.base, 0);
  const tax = rows.reduce((s, r) => s + r.tax, 0);
  return { net, tax, gross: reverseCharge ? net : net + tax, taxes: rows };
};

/** Salden je Konto und Steuerschlüssel: so vergleicht der Abgleich eine Buchung mit ihren Angaben */
const salden = (lines: PostingLine[]) => {
  const result: Record<string, number> = {};
  for (const l of lines) {
    const key = `${l.account}|${l.taxCode ?? ""}`;
    result[key] = (result[key] ?? 0) + l.debit - l.credit;
  }
  return Object.fromEntries(Object.entries(result).filter(([, v]) => v !== 0));
};

describe("positionenAusSaetzen (#1975)", () => {
  it("macht aus einem Beleg ohne Privatanteil eine Position je Satz", () => {
    expect(
      positionenAusSaetzen("telefon", 0, [
        { taxRate: 1900, net: 10_000, tax: 1900 },
        { taxRate: 700, net: 500, tax: 35 },
      ]),
    ).toEqual([
      { category: "telefon", taxRate: 1900, net: 10_000, tax: 1900 },
      { category: "telefon", taxRate: 700, net: 500, tax: 35 },
    ]);
  });

  it("spaltet den Privatanteil je Satz nach der Regel des Belegs ab, auch die Steuer", () => {
    // 25 % von 10,01 € netto und 1,90 € Steuer: privat 2,50 € und 0,48 € (0,475 aufgerundet), betrieblich der Rest
    const positionen = positionenAusSaetzen("telefon", 25, [{ taxRate: 1900, net: 1001, tax: 190 }]);
    expect(positionen).toEqual([
      { category: "telefon", taxRate: 1900, net: 751, tax: 142 },
      { category: "privatentnahme", taxRate: 1900, net: 250, tax: 48 },
    ]);
    // Nach Netto verteilt bekäme die Entnahme 0,47 €: Deshalb trägt die Position die Steuer der bisherigen Rechnung
    expect(allocateSplitTax(positionen, [{ taxRate: 1900, net: 1001, tax: 190 }])[1]!.tax).toBe(47);
  });

  it("behält bei 100 % die betriebliche Position mit 0, damit die Kategorie bleibt", () => {
    expect(positionenAusSaetzen("kfz", 100, [{ taxRate: 1900, net: 1000, tax: 190 }])).toEqual([
      { category: "kfz", taxRate: 1900, net: 0, tax: 0 },
      { category: "privatentnahme", taxRate: 1900, net: 1000, tax: 190 },
    ]);
  });

  it("teilt bei Fremdwährung auch das Netto laut Beleg, selbst solange die Euro-Beträge ohne Kurs 0 sind", () => {
    expect(positionenAusSaetzen("software", 50, [{ taxRate: 0, net: 0, tax: 0, originalNet: 2001 }])).toEqual([
      { category: "software", taxRate: 0, net: 0, tax: 0, originalNet: 1000 },
      { category: "privatentnahme", taxRate: 0, net: 0, tax: 0, originalNet: 1001 },
    ]);
  });

  it("lässt eine Entnahme von 0 Cent weg und nimmt die Kategorie ohne Beträge als Position zu 19 %", () => {
    expect(positionenAusSaetzen("telefon", 1, [{ taxRate: 700, net: 20, tax: 1 }])).toEqual([{ category: "telefon", taxRate: 700, net: 20, tax: 1 }]);
    expect(positionenAusSaetzen("telefon", 0, [])).toEqual([{ category: "telefon", taxRate: 1900, net: 0, tax: 0 }]);
    expect(positionenAusSaetzen(null, 0, [])).toEqual([]);
  });
});

describe("einzigeKontierung", () => {
  it("findet die eine betriebliche Kontierung neben Entnahmen", () => {
    const zeilen = positionenAusSaetzen("telefon", 25, [
      { taxRate: 1900, net: 1000, tax: 190 },
      { taxRate: 700, net: 100, tax: 7 },
    ]);
    expect(einzigeKontierung(zeilen)?.category).toBe("telefon");
  });

  it("ist null bei zwei Kategorien, bei nur Entnahmen und ohne Zeilen", () => {
    const zwei = [
      { category: "telefon", taxRate: 1900, net: 1, tax: 0 },
      { category: "internet", taxRate: 1900, net: 1, tax: 0 },
    ];
    expect(einzigeKontierung(zwei)).toBeNull();
    expect(einzigeKontierung([{ category: "privatentnahme", taxRate: 1900, net: 1, tax: 0 }])).toBeNull();
    expect(einzigeKontierung([])).toBeNull();
  });

  it("unterscheidet nach dem Schlüssel, etwa dem eigenen Konto", () => {
    const zeilen = [
      { category: "software", konto: "a", taxRate: 1900, net: 1, tax: 0 },
      { category: "software", konto: "b", taxRate: 700, net: 1, tax: 0 },
    ];
    expect(einzigeKontierung(zeilen, (z) => `${z.category}|${z.konto}`)).toBeNull();
    expect(einzigeKontierung(zeilen)?.category).toBe("software");
  });
});

describe("privatanteilDerPositionen", () => {
  it("findet den Prozentsatz, aus dem die Positionen entstanden sind", () => {
    const amounts = [
      { taxRate: 1900, net: 3360, tax: 638 },
      { taxRate: 700, net: 853, tax: 60 },
    ];
    for (const prozent of [0, 1, 25, 40, 99, 100]) {
      expect(privatanteilDerPositionen(positionenAusSaetzen("telefon", prozent, amounts))).toBe(prozent);
    }
  });

  it("nimmt bei mehreren passenden Sätzen zuerst den Vorschlag", () => {
    // Bei 0,10 € ergeben 24 % und 25 % dieselben Positionen
    const zeilen = positionenAusSaetzen("telefon", 25, [{ taxRate: 1900, net: 10, tax: 2 }]);
    expect(privatanteilDerPositionen(zeilen, [25])).toBe(25);
    expect(privatanteilDerPositionen(zeilen)).not.toBeNull();
  });

  it("ist null, wenn keine Prozentzahl die Positionen ergibt", () => {
    expect(
      privatanteilDerPositionen([
        { category: "telefon", taxRate: 1900, net: 1000, tax: 190 },
        { category: "privatentnahme", taxRate: 1900, net: 333, tax: 1 },
      ]),
    ).toBeNull();
    // Zwei betriebliche Positionen im selben Satz sind keine Form „Kategorie und Privatanteil“
    expect(
      privatanteilDerPositionen([
        { category: "telefon", taxRate: 1900, net: 1000, tax: 190 },
        { category: "telefon", taxRate: 1900, net: 1000, tax: 190 },
      ]),
    ).toBeNull();
  });
});

describe("betraegeAusPositionen", () => {
  it("summiert das Netto je Satz und rechnet die Steuer, außer sie ist laut Rechnung korrigiert", () => {
    const positionen = [
      { taxRate: 1900, net: 3360 },
      { taxRate: 1900, net: 853 },
      { taxRate: 700, net: 1000 },
    ];
    expect(betraegeAusPositionen(positionen)).toEqual([
      { taxRate: 1900, net: 4213, tax: 800 },
      { taxRate: 700, net: 1000, tax: 70 },
    ]);
    // § 14 Abs. 4 Nr. 8 UStG: maßgeblich ist der Steuerbetrag laut Rechnung je Satz
    expect(betraegeAusPositionen(positionen, [{ taxRate: 1900, tax: 801 }])[0]).toEqual({ taxRate: 1900, net: 4213, tax: 801 });
  });
});

describe("documentPosting mit Entnahmezeilen statt Prozent (#1975)", () => {
  const faelle: { name: string; rows: { rate: number; base: number; tax: number; vorsteuerAnteil?: number }[]; rc?: "eu" | "drittland" | "ig_erwerb" }[] = [
    { name: "ein Satz", rows: [{ rate: 1900, base: 1001, tax: 190 }] },
    {
      name: "zwei Sätze",
      rows: [
        { rate: 1900, base: 3360, tax: 638 },
        { rate: 700, base: 853, tax: 60 },
      ],
    },
    { name: "Teilabzug § 15 Abs. 4", rows: [{ rate: 1900, base: 12_345, tax: 2346, vorsteuerAnteil: 6000 }] },
    { name: "Gutschrift", rows: [{ rate: 1900, base: -1001, tax: -190 }] },
    { name: "§ 13b", rows: [{ rate: 1900, base: 1001, tax: 190 }], rc: "eu" },
    { name: "Erwerb", rows: [{ rate: 700, base: 1001, tax: 70 }], rc: "ig_erwerb" },
  ];
  for (const fall of faelle) {
    for (const vorsteuerAbzug of [true, false]) {
      for (const prozent of [1, 25, 40, 99]) {
        it(`${fall.name}, ${prozent} %, ${vorsteuerAbzug ? "mit" : "ohne"} Vorsteuerabzug: dieselben Salden wie der Prozentsatz`, () => {
          const t = totals(fall.rows, Boolean(fall.rc));
          const amounts = fall.rows.map((r) => ({ taxRate: r.rate, net: r.base, tax: r.tax }));
          const entnahme = belegPrivat(0, positionenAusSaetzen("telefon", prozent, amounts)).entnahme;
          for (const kontenrahmen of ["SKR03", "SKR04"] as const) {
            const prozentual = documentPosting(t, "telefon", kontenrahmen, "einzelunternehmen", "bank", vorsteuerAbzug, undefined, prozent, fall.rc ?? null);
            const zeilen = documentPosting(t, "telefon", kontenrahmen, "einzelunternehmen", "bank", vorsteuerAbzug, undefined, entnahme, fall.rc ?? null);
            expect(salden(zeilen)).toEqual(salden(prozentual));
          }
        });
      }
    }
  }

  it("lehnt Entnahmezeilen in GmbH und UG ab wie den Prozentsatz", () => {
    const t = totals([{ rate: 1900, base: 1000, tax: 190 }]);
    expect(() => documentPosting(t, "telefon", "SKR03", "gmbh", "bank", true, undefined, [{ rate: 1900, base: 250, tax: 48 }])).toThrow(/Einzelunternehmen/);
  });
});
