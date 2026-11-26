import { beforeEach, describe, expect, it } from "vitest";
import {
  positionenSummen,
  privatanteilAbspalten,
  privatZulaessig,
  pruefePrivatpositionen,
  saetzeAusBrutto,
  summenProbe,
  type Position,
} from "./beleg-positionen.ts";
import type { TaxShare } from "./steueranteile.ts";

/*
 * Telefonrechnung aus #1914/#1975: Internet 33,60 € und Telefon 8,53 € netto zu 19 %, zusammen 42,13 € netto und
 * 8,01 € Steuer aus 50,14 € brutto. Internet ist zu 25 % privat, Telefon zu 40 %. Betrieblich bleiben 30,32 € netto
 * und 5,76 € Vorsteuer; die Entnahme ist 11,81 € netto und 2,25 € Steuer, also 14,06 € brutto.
 *
 * Die Fixtures entstehen in beforeEach: Würde das Abspalten schon beim Import scheitern, verdeckte der Fehler alle Tests.
 */
let internet: Position;
let telefon: Position;
let telefonSteuer: TaxShare[];
let internetTeile: { betrieblich: Position; privat: Position };
let telefonTeile: { betrieblich: Position; privat: Position };
let telefonRechnung: Position[];

beforeEach(() => {
  internet = { kategorie: "internet", rate: 1900, net: 3_360, beschreibung: "Internet" };
  telefon = { kategorie: "telefon", rate: 1900, net: 853 };
  telefonSteuer = [{ rate: 1900, base: 4_213, tax: 801 }];
  internetTeile = privatanteilAbspalten(internet, 25);
  telefonTeile = privatanteilAbspalten(telefon, 40);
  telefonRechnung = [internetTeile.betrieblich, telefonTeile.betrieblich, internetTeile.privat, telefonTeile.privat];
});

describe("betrieblicher Teil je Position", () => {
  it("rechnet die Telefonrechnung centgenau in betrieblich und Entnahme", () => {
    const summen = positionenSummen(telefonRechnung, telefonSteuer);
    expect(summen.saetze).toEqual([{ rate: 1900, base: 3_032, tax: 576 }]);
    expect(summen.net).toBe(3_032);
    expect(summen.tax).toBe(576);
    expect(summen.gross).toBe(3_608);
    expect(summen.privat).toEqual({ net: 1_181, tax: 225, gross: 1_406, saetze: [{ rate: 1900, base: 1_181, tax: 225 }] });
    // Die Steuer des Satzes wird verteilt, nicht je Position aus Netto × Satz gerechnet: 4,79 € und 0,97 € betrieblich,
    // 1,60 € und 0,65 € für die Entnahme.
    expect(summen.zeilen.map((zeile) => zeile.tax + zeile.privatTax)).toEqual([479, 97, 160, 65]);
    // Reihenfolge, Index und Kategorie der Eingabe bleiben erhalten
    expect(summen.zeilen.map((zeile) => zeile.index)).toEqual([0, 1, 2, 3]);
    expect(summen.zeilen.map((zeile) => zeile.kategorie)).toEqual(["internet", "telefon", "privatentnahme", "privatentnahme"]);
    // Die Entnahmepositionen tragen ihre Entnahme, betrieblich bleibt bei ihnen exakt 0
    expect(summen.zeilen[2]).toMatchObject({ net: 0, tax: 0, privatNet: 840, privatTax: 160 });
    expect(summen.zeilen[3]).toMatchObject({ net: 0, tax: 0, privatNet: 341, privatTax: 65 });
  });

  it("lässt eine Rechnung ohne Privatanteil, wie sie ist", () => {
    const ohne: Position[] = [{ kategorie: "hardware", rate: 1900, net: 4_213 }];
    const summen = positionenSummen(ohne, [{ rate: 1900, base: 4_213, tax: 801 }]);
    expect(summen).toMatchObject({ net: 4_213, tax: 801, gross: 5_014 });
    expect(summen.privat).toEqual({ net: 0, tax: 0, gross: 0, saetze: [] });
  });

  it("nimmt einen festen Betrag auf Netto-Basis unverändert und ganz als Entnahme", () => {
    const netto: Position = { kategorie: "privatentnahme", rate: 1900, net: 1_000 };
    const summen = positionenSummen([netto], [{ rate: 1900, base: 1_000, tax: 190 }]);
    expect(summen.net).toBe(0);
    expect(summen.tax).toBe(0);
    expect(summen.privat).toEqual({ net: 1_000, tax: 190, gross: 1_190, saetze: [{ rate: 1900, base: 1_000, tax: 190 }] });
  });

  it("bucht 12,99 € brutto als eigene Privatentnahme ohne betrieblichen Anteil", () => {
    const saetze = saetzeAusBrutto([{ rate: 1900, gross: 1_299 }]);
    expect(saetze).toEqual([{ rate: 1900, base: 1_092, tax: 207 }]);
    const netflix: Position = { kategorie: "privatentnahme", rate: 1900, net: 1_092 };
    const summen = positionenSummen([netflix], saetze);
    expect(summen.zeilen[0]).toMatchObject({ net: 0, tax: 0, privatNet: 1_092, privatTax: 207 });
    expect(summen.privat).toEqual({ net: 1_092, tax: 207, gross: 1_299, saetze: [{ rate: 1900, base: 1_092, tax: 207 }] });
  });
});

describe("Privatanteil abspalten", () => {
  it("teilt 33,60 € zu 25 % in 25,20 € betrieblich und 8,40 € privat", () => {
    expect(internetTeile.betrieblich).toEqual({ kategorie: "internet", rate: 1900, net: 2_520, beschreibung: "Internet" });
    expect(internetTeile.privat).toEqual({ kategorie: "privatentnahme", rate: 1900, net: 840, beschreibung: "25 % von Internet" });
  });

  it("rundet den privaten Anteil und rechnet den betrieblichen als Differenz", () => {
    // 3,34 € zu 25 %: 25 % sind kaufmännisch 0,84 €, wie es die Beschreibung nennt; betrieblich bleiben 2,50 €.
    // Beide Hälften getrennt zu runden ergäbe 2,51 € + 0,84 € = 3,35 €, einen Cent zu viel; die Differenz verhindert das.
    const { betrieblich, privat } = privatanteilAbspalten({ kategorie: "telefon", rate: 1900, net: 334 }, 25);
    expect(betrieblich.net).toBe(250);
    expect(privat.net).toBe(84);
    expect(betrieblich.net + privat.net).toBe(334);
  });

  it("behält bei einer Gutschrift das Vorzeichen", () => {
    const { betrieblich, privat } = privatanteilAbspalten({ kategorie: "telefon", rate: 1900, net: -334 }, 25);
    expect(betrieblich.net).toBe(-250);
    expect(privat.net).toBe(-84);
    expect(betrieblich.net + privat.net).toBe(-334);
  });

  it("lässt das Konto nur am betrieblichen Teil und nimmt sonst die Kategorie in die Beschreibung", () => {
    const { betrieblich, privat } = privatanteilAbspalten({ kategorie: "telefon", rate: 1900, net: 853, konto: "4920" }, 40);
    expect(betrieblich).toMatchObject({ net: 512, konto: "4920" });
    expect(privat).toEqual({ kategorie: "privatentnahme", rate: 1900, net: 341, beschreibung: "40 % von telefon" });
  });

  it("gibt zwei getrennte Positionen zurück, die eine Änderung der Ausgangsposition nicht mehr trifft", () => {
    const quelle: Position = { kategorie: "internet", rate: 1900, net: 3_360, beschreibung: "Internet" };
    const erste = privatanteilAbspalten(quelle, 25);
    const zweite = privatanteilAbspalten({ ...quelle, net: 1_000 }, 25);
    // Die Entnahme ist gespeichert, nicht nachgerechnet: eine spätere Korrektur der Quelle ändert sie nicht
    quelle.net = 4_200;
    quelle.beschreibung = "Internet korrigiert";
    expect(erste.betrieblich.net).toBe(2_520);
    expect(erste.privat).toEqual({ kategorie: "privatentnahme", rate: 1900, net: 840, beschreibung: "25 % von Internet" });
    expect(zweite.betrieblich.net).toBe(750);
    expect(zweite.privat.net).toBe(250);
  });

  it("weist 0 und 100 Prozent ab", () => {
    expect(() => privatanteilAbspalten(internet, 0)).toThrow(RangeError);
    expect(() => privatanteilAbspalten(internet, 100)).toThrow(RangeError);
  });

  it("weist das Abspalten von der Privatentnahme ab", () => {
    expect(() => privatanteilAbspalten({ kategorie: "privatentnahme", rate: 1900, net: 840 }, 25)).toThrow(/Privatentnahme/);
  });
});

describe("Steuer je Satz", () => {
  it("verteilt die Steuer des Satzes über allocateSplitTax und summiert exakt 8,01 €", () => {
    const positionen: Position[] = [
      { kategorie: "ware", rate: 1900, net: 1_000 },
      { kategorie: "ware", rate: 1900, net: 1_000 },
      { kategorie: "ware", rate: 1900, net: 2_213 },
    ];
    const summen = positionenSummen(positionen, [{ rate: 1900, base: 4_213, tax: 801 }]);
    // Je Position gerundet ergäben 19 % nur 1,90 € + 1,90 € + 4,20 € = 8,00 €
    expect(summen.zeilen.map((zeile) => zeile.tax)).toEqual([190, 190, 421]);
    expect(summen.tax).toBe(801);
    expect(summenProbe(summen, [{ rate: 1900, base: 4_213, tax: 801 }])).toEqual([]);
  });

  it("legt den Rundungsrest auf die größte Position, damit die Steuer des Satzes aufgeht", () => {
    // 100 Cent auf drei gleiche Nettos: je 33 Cent, zusammen 99; ohne Restverteilung fehlte ein Cent
    const positionen: Position[] = [
      { kategorie: "ware", rate: 1900, net: 1_000 },
      { kategorie: "ware", rate: 1900, net: 1_000 },
      { kategorie: "ware", rate: 1900, net: 1_000 },
    ];
    const summen = positionenSummen(positionen, [{ rate: 1900, base: 3_000, tax: 100 }]);
    expect(summen.zeilen.map((zeile) => zeile.tax)).toEqual([34, 33, 33]);
    expect(summen.tax).toBe(100);
    expect(summenProbe(summen, [{ rate: 1900, base: 3_000, tax: 100 }])).toEqual([]);
  });

  it("teilt 50,14 € brutto zu 19 % in 42,13 € netto und 8,01 € Steuer und verteilt sie auf zwei Positionen", () => {
    const saetze = saetzeAusBrutto([{ rate: 1900, gross: 5_014 }]);
    expect(saetze).toEqual([{ rate: 1900, base: 4_213, tax: 801 }]);
    const summen = positionenSummen(
      [
        { kategorie: "ware", rate: 1900, net: 3_000 },
        { kategorie: "versand", rate: 1900, net: 1_213 },
      ],
      saetze,
    );
    expect(summen.zeilen.map((zeile) => zeile.tax)).toEqual([570, 231]);
    expect(summen).toMatchObject({ net: 4_213, tax: 801, gross: 5_014 });
  });

  it("zählt Brutto je Satz zusammen, bevor es teilt", () => {
    expect(
      saetzeAusBrutto([
        { rate: 1900, gross: 5_014 },
        { rate: 700, gross: 1_070 },
        { rate: 1900, gross: 1_299 },
      ]),
    ).toEqual([
      { rate: 1900, base: 5_305, tax: 1_008 },
      { rate: 700, base: 1_000, tax: 70 },
    ]);
  });

  it("summiert zwei Steuersätze getrennt und verteilt je Satz auf dessen Positionen", () => {
    const gemischt: Position[] = [
      { kategorie: "ware", rate: 1900, net: 3_000 },
      { kategorie: "ware", rate: 1900, net: 10_000 },
      { kategorie: "buch", rate: 700, net: 5_000 },
    ];
    const vorgabe = [
      { rate: 1900, base: 13_000, tax: 2_471 },
      { rate: 700, base: 5_000, tax: 350 },
    ];
    const summen = positionenSummen(gemischt, vorgabe);
    expect(summen.saetze).toEqual(vorgabe);
    expect(summen).toMatchObject({ net: 18_000, tax: 2_821, gross: 20_821 });
    expect(summen.zeilen.map((zeile) => zeile.tax)).toEqual([570, 1_901, 350]);
  });

  it("nimmt für einen Satz, den die Vorgabe nicht kennt, Netto × Satz", () => {
    const summen = positionenSummen(
      [
        { kategorie: "ware", rate: 1900, net: 1_000 },
        { kategorie: "buch", rate: 700, net: 1_000 },
      ],
      [{ rate: 1900, base: 1_000, tax: 190 }],
    );
    expect(summen.zeilen.map((zeile) => zeile.tax)).toEqual([190, 70]);
    expect(summen.saetze).toEqual([
      { rate: 1900, base: 1_000, tax: 190 },
      { rate: 700, base: 1_000, tax: 70 },
    ]);
  });

  it("teilt die Steuer je Satz zuerst zwischen Betrieb und Entnahme, unabhängig von der Reihenfolge (#1976)", () => {
    // Fünf Positionen zu je 3 ct netto, Steuer der Rechnung 3 ct. Vorher trug die erste Zeile den Rundungsrest: Stand
    // die Entnahme vorn, blieben betrieblich 4 ct und bei ihr −1 ct; stand sie hinten, waren es 2 ct und 1 ct.
    const betrieb: Position[] = Array.from({ length: 4 }, () => ({ kategorie: "ware", rate: 1900, net: 3 }));
    const entnahme: Position = { kategorie: "privatentnahme", rate: 1900, net: 3 };
    const steuer = [{ rate: 1900, base: 15, tax: 3 }];
    for (const positionen of [
      [entnahme, ...betrieb],
      [...betrieb, entnahme],
    ]) {
      const summen = positionenSummen(positionen, steuer);
      expect(summen.tax).toBe(2);
      expect(summen.privat.tax).toBe(1);
      expect(summen.tax + summen.privat.tax).toBe(3);
    }
  });

  it("geht auch als Gutschrift auf: alles negativ, die Steuer bleibt negativ (#1976)", () => {
    const betrieb: Position[] = Array.from({ length: 4 }, () => ({ kategorie: "ware", rate: 1900, net: -3 }));
    const entnahme: Position = { kategorie: "privatentnahme", rate: 1900, net: -3 };
    const steuer = [{ rate: 1900, base: -15, tax: -3 }];
    for (const positionen of [
      [entnahme, ...betrieb],
      [...betrieb, entnahme],
    ]) {
      const summen = positionenSummen(positionen, steuer);
      expect(summen.tax).toBe(-2);
      expect(summen.privat.tax).toBe(-1);
      expect(summen.tax + summen.privat.tax).toBe(-3);
    }
  });
});

describe("Rechtsform", () => {
  it("weist Privatentnahmen bei GmbH und UG ab", () => {
    const privat: Position = { kategorie: "privatentnahme", rate: 1900, net: 1_092 };
    expect(privatZulaessig("einzelunternehmen")).toBe(true);
    expect(privatZulaessig("gmbh")).toBe(false);
    expect(privatZulaessig("ug")).toBe(false);
    expect(pruefePrivatpositionen([privat], "gmbh")).toHaveLength(1);
    expect(pruefePrivatpositionen([privat], "ug")).toHaveLength(1);
    expect(pruefePrivatpositionen([privat], "einzelunternehmen")).toEqual([]);
  });
});

describe("Summenprobe", () => {
  it("betrieblich plus Entnahme ergibt genau die Positionen", () => {
    const netflix: Position = { kategorie: "privatentnahme", rate: 1900, net: 1_092 };
    const positionen = [...telefonRechnung, netflix];
    const vorgabe = [{ rate: 1900, base: 5_305, tax: 1_008 }];
    const summen = positionenSummen(positionen, vorgabe);
    expect(summen.net + summen.privat.net).toBe(5_305);
    expect(summen.tax + summen.privat.tax).toBe(1_008);
    expect(summen.gross + summen.privat.gross).toBe(6_313);
    expect(summen.privat).toEqual({ net: 2_273, tax: 432, gross: 2_705, saetze: [{ rate: 1900, base: 2_273, tax: 432 }] });
    expect(summenProbe(summen, vorgabe)).toEqual([]);
    // Eine abweichende Vorgabe wird gemeldet, nicht stillschweigend übernommen
    expect(summenProbe(summen, [{ rate: 1900, base: 5_305, tax: 1_009 }])).toHaveLength(1);
  });

  it("meldet Sätze, die nur in den Summen stehen, auch bei leerer Vorgabe", () => {
    const positionen: Position[] = [
      { kategorie: "ware", rate: 1900, net: 1_000 },
      { kategorie: "buch", rate: 700, net: 1_000 },
    ];
    const summen = positionenSummen(positionen, [{ rate: 1900, base: 1_000, tax: 190 }]);
    expect(summenProbe(summen, [])).toHaveLength(2);
    const issues = summenProbe(summen, [{ rate: 1900, base: 1_000, tax: 190 }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("7 %");
    expect(issues[0]).toContain("stehen nicht in der Vorgabe");
  });

  it("meldet einen Satz mit Steuer, aber ohne Netto", () => {
    const vorgabe = [{ rate: 700, base: 0, tax: 50 }];
    const summen = positionenSummen([{ kategorie: "buch", rate: 700, net: 0 }], vorgabe);
    // Ohne Netto gibt es nichts zu verteilen; die Steuer der Vorgabe bleibt offen und wird gemeldet
    expect(summen.tax).toBe(0);
    expect(summen.saetze).toEqual([]);
    const issues = summenProbe(summen, vorgabe);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("Steuer 0,00");
  });

  it("meldet einen Satz, den nur die Positionen kennen (#1976)", () => {
    // Rechnung 42,13 € zu 19 %, Positionen zusätzlich 10,00 € zu 7 %: die 10,70 € brutto stehen auf keiner Rechnung
    const positionen: Position[] = [
      { kategorie: "ware", rate: 1900, net: 4_213 },
      { kategorie: "literatur", rate: 700, net: 1_000 },
    ];
    const vorgabe = [{ rate: 1900, base: 4_213, tax: 801 }];
    const issues = summenProbe(positionenSummen(positionen, vorgabe), vorgabe);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.includes("7 %"))).toBe(true);
  });

  it("weist Plus und Minus im selben Satz ab, auch wenn sie sich zu Netto 0 aufheben (#1976)", () => {
    const positionen: Position[] = [
      { kategorie: "ware", rate: 1900, net: 10_000 },
      { kategorie: "privatentnahme", rate: 1900, net: -10_000 },
    ];
    const vorgabe = [{ rate: 1900, base: 0, tax: 0 }];
    const issues = summenProbe(positionenSummen(positionen, vorgabe), vorgabe);
    expect(issues.some((issue) => issue.includes("Plus und Minus"))).toBe(true);
  });
});
