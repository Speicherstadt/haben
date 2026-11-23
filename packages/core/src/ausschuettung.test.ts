import { describe, expect, it } from "vitest";
import { abweichendeAnteile, ausEinlagekonto, ausschuettungAnteil, ausschuettungPosting, kapestFrist, nachBeteiligung, steuerabzug } from "./ausschuettung.ts";
import { directBookingsFor, directPosting } from "./posting.ts";

describe("Steuerabzug auf Gewinnausschüttungen", () => {
  it.each([
    // 25 % KapESt, 5,5 % Soli
    [0, { kapest: 250_000, soli: 13_750, kist: 0 }],
    // § 32d Abs. 1 Satz 4 EStG: e / (4 + k) – 10.000 € / 4,09 = 2.444,98 €, KiSt 9 % = 220,04 €, Soli 134,47 €
    [9, { kapest: 244_498, soli: 13_447, kist: 22_004 }],
    // 8 % (Bayern, Baden-Württemberg): 10.000 € / 4,08 = 2.450,98 €
    [8, { kapest: 245_098, soli: 13_480, kist: 19_607 }],
  ] as const)("10.000 € mit Kirchensteuer %i %%", (kirchensteuer, abzug) => {
    expect(steuerabzug(1_000_000, kirchensteuer)).toEqual(abzug);
  });

  it("nichts auf 0 oder negative Erträge", () => {
    expect(steuerabzug(0, 9)).toEqual({ kapest: 0, soli: 0, kist: 0 });
  });

  it("Anteil: aus dem Einlagekonto ohne Abzug, netto ist brutto minus Steuern", () => {
    expect(ausschuettungAnteil({ brutto: 1_000_000, ausEinlagekonto: 200_000, kirchensteuer: 0 })).toMatchObject({
      ertrag: 800_000,
      kapest: 200_000,
      soli: 11_000,
      netto: 1_000_000 - 211_000,
    });
  });

  it.each([
    // Ausschüttbarer Gewinn reicht: kein Einlagekonto
    [1_000_000, 2_000_000, 500_000, 0],
    // Übersteigt ihn: Rest aus dem Einlagekonto
    [1_000_000, 700_000, 500_000, 300_000],
    // Höchstens bis zum Bestand
    [1_000_000, 0, 200_000, 200_000],
    // Negativer ausschüttbarer Gewinn zählt als 0
    [1_000_000, -500_000, 2_000_000, 1_000_000],
  ])("§ 27 KStG: Leistung %i, ausschüttbarer Gewinn %i, Einlagekonto %i → %i", (leistung, gewinn, konto, erwartet) => {
    expect(ausEinlagekonto(leistung, gewinn, konto)).toBe(erwartet);
  });
});

describe("Verteilung nach den Nennbeträgen der Geschäftsanteile (§ 29 Abs. 3 Satz 1 GmbHG)", () => {
  it("drei gleiche Beteiligungen bekommen gleich viel, auch wenn die Anteile in Prozent nicht aufgehen (33,34 / 33,33 / 33,33)", () => {
    expect(nachBeteiligung(9_000_000, [1_000_000, 1_000_000, 1_000_000])).toEqual([3_000_000, 3_000_000, 3_000_000]);
  });

  it("12.500 / 8.333 / 4.167 € Beteiligung: 100.000 € ergeben 50.000 / 33.332 / 16.668 €", () => {
    expect(nachBeteiligung(10_000_000, [1_250_000, 833_300, 416_700])).toEqual([5_000_000, 3_333_200, 1_666_800]);
  });

  it.each([
    // 1 Cent auf drei: der Rest an die größten Nachkommareste, bei gleichen an den ersten
    [1, [1_000_000, 1_000_000, 1_000_000], [1, 0, 0]],
    [100, [1_000_000, 1_000_000, 1_000_000], [34, 33, 33]],
    // 100 € nach 2 : 1 : 1 €: 50 / 25 / 25 €
    [10_000, [200, 100, 100], [5_000, 2_500, 2_500]],
    // 10,01 € nach 3 : 7: 3,003 und 7,007 → 3,00 und 7,01
    [1_001, [300, 700], [300, 701]],
    // Wer keine Beteiligung hat, bekommt nichts
    [10_000, [0, 2_500_000], [0, 10_000]],
  ])("Rundungsreste: %i Cent nach %j → %j, die Summe stimmt", (betrag, beteiligungen, erwartet) => {
    const teile = nachBeteiligung(betrag, beteiligungen);
    expect(teile).toEqual(erwartet);
    expect(teile.reduce((s, x) => s + x, 0)).toBe(betrag);
  });

  it("ganzzahlig auch über Number.MAX_SAFE_INTEGER: 100 Mrd. € nach 87.093.310 und 89.990.781 €", () => {
    // Betrag mal Beteiligung ist rund 9 · 10^22; in Gleitkomma ergäbe das 4.918.189.404.152 und 5.081.810.595.848 Cent
    expect(nachBeteiligung(10_000_000_000_000, [8_709_331_000, 8_999_078_100])).toEqual([4_918_189_404_151, 5_081_810_595_849]);
  });

  it("ohne Beteiligung lässt sich nicht verteilen", () => {
    expect(() => nachBeteiligung(10_000, [0, 0])).toThrow(RangeError);
    expect(() => nachBeteiligung(10_000, [])).toThrow(RangeError);
  });
});

describe("Anteil in Prozent, der nicht zur Beteiligung in Euro passt", () => {
  const eigner = (...paare: [beteiligung: number, anteil: number][]) => paare.map(([beteiligung, anteil]) => ({ beteiligung, anteil }));

  it("je 25.000 €, aber 60 / 40 %: beide weichen ab, nach der Beteiligung wären es je 50 %", () => {
    expect(abweichendeAnteile(eigner([2_500_000, 6000], [2_500_000, 4000]))).toEqual([
      { index: 0, nachBeteiligung: 5000 },
      { index: 1, nachBeteiligung: 5000 },
    ]);
  });

  it.each([
    // Auf 100 % gerundet: 33,34 % liegt 0,0067 Prozentpunkte über einem Drittel, noch in der Rundung
    ["je 10.000 €, 33,34 / 33,33 / 33,33 %", eigner([1_000_000, 3334], [1_000_000, 3333], [1_000_000, 3333])],
    ["12.500 / 8.333 / 4.167 €, 50 / 33,33 / 16,67 %", eigner([1_250_000, 5000], [833_300, 3333], [416_700, 1667])],
    // Genau 0,01 Prozentpunkte daneben: 1 € von 10.000 € sind 0,01 %, eingetragen 0,02 %
    ["genau eine Rundungsstufe daneben", eigner([100, 2], [999_900, 9998])],
    ["ein Gesellschafter mit 100 %", eigner([2_500_000, 10_000])],
    // Fehlende Beteiligungen meldet der Vorschlag selbst; hier gibt es kein Verhältnis
    ["ohne Beteiligungen", eigner([0, 5000], [0, 5000])],
  ])("passt: %s", (_, anteilseigner) => {
    expect(abweichendeAnteile(anteilseigner)).toEqual([]);
  });

  it("mehr als 0,01 Prozentpunkte daneben: 33,35 und 33,32 % bei je einem Drittel; nach der Beteiligung gerundet 33,33 %", () => {
    expect(abweichendeAnteile(eigner([1_000_000, 3335], [1_000_000, 3333], [1_000_000, 3332]))).toEqual([
      { index: 0, nachBeteiligung: 3333 },
      { index: 2, nachBeteiligung: 3333 },
    ]);
  });

  it("große Beteiligungen: Anteil mal Summe liegt über Number.MAX_SAFE_INTEGER", () => {
    // 5.000 Hundertstel mal 180 Mrd. € in Cent; 1 Cent mehr bei Ben verschiebt nichts
    expect(abweichendeAnteile(eigner([9_000_000_000_000, 5000], [9_000_000_000_001, 5000]))).toEqual([]);
    expect(abweichendeAnteile(eigner([9_000_000_000_000, 5002], [9_000_000_000_000, 4998]))).toEqual([
      { index: 0, nachBeteiligung: 5000 },
      { index: 1, nachBeteiligung: 5000 },
    ]);
  });
});

describe.each([
  ["SKR03", { vortrag: "0860", gesellschafter: "0730", einbehalt: "1746" }],
  ["SKR04", { vortrag: "2970", gesellschafter: "3510", einbehalt: "3760" }],
] as const)("Buchung der Ausschüttung %s", (kontenrahmen, k) => {
  it("Gewinnvortrag an Gesellschafter (netto) und Einbehaltungen; ausgeglichen", () => {
    const anteile = [
      ausschuettungAnteil({ brutto: 600_000, ausEinlagekonto: 0, kirchensteuer: 9 }),
      ausschuettungAnteil({ brutto: 400_000, ausEinlagekonto: 0, kirchensteuer: 0 }),
    ];
    const lines = ausschuettungPosting(kontenrahmen, anteile);
    const steuern = anteile.reduce((s, a) => s + a.kapest + a.soli + a.kist, 0);
    expect(lines).toEqual([
      { account: k.vortrag, debit: 1_000_000, credit: 0 },
      { account: k.gesellschafter, debit: 0, credit: 1_000_000 - steuern },
      { account: k.einbehalt, debit: 0, credit: steuern },
    ]);
  });

  it("ganz aus dem Einlagekonto: keine Einbehaltung", () => {
    const lines = ausschuettungPosting(kontenrahmen, [ausschuettungAnteil({ brutto: 100_000, ausEinlagekonto: 100_000, kirchensteuer: 9 })]);
    expect(lines.map((l) => l.account)).toEqual([k.vortrag, k.gesellschafter]);
  });
});

describe("Zahlung der einbehaltenen Steuern an das Finanzamt (Bankabgleich)", () => {
  it.each([
    ["SKR03", "1200", "1746"],
    ["SKR04", "1800", "3760"],
  ] as const)("%s: Einbehaltungen an Bank, nur in GmbH und UG", (kontenrahmen, bank, einbehalt) => {
    expect(directBookingsFor("gmbh")).toContain("kapest");
    expect(directBookingsFor("einzelunternehmen")).not.toContain("kapest");
    expect(directPosting("kapest", -137_500, kontenrahmen, "ug")).toEqual([
      { account: bank, debit: 0, credit: 137_500, taxCode: null },
      { account: einbehalt, debit: 137_500, credit: 0, taxCode: null },
    ]);
    expect(() => directPosting("kapest", -100, kontenrahmen, "einzelunternehmen")).toThrow("nur in GmbH und UG");
  });
});

describe("Frist der Kapitalertragsteuer-Anmeldung", () => {
  it.each([
    // 10. Juli 2026 ist ein Freitag
    ["2026-06-30", "2026-07-10"],
    // 10. Januar 2027 ist ein Sonntag: Montag, 11.
    ["2026-12-15", "2027-01-11"],
    // 10. Oktober 2026 ist ein Samstag: Montag, 12.
    ["2026-09-01", "2026-10-12"],
  ])("Zufluss %s: bis %s", (zufluss, frist) => {
    expect(kapestFrist(zufluss, "BY")).toBe(frist);
  });
});
