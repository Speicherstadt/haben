import { describe, expect, it } from "vitest";
import {
  positionenSummen,
  privatanteilAbspalten,
  privatZulaessig,
  pruefePrivatpositionen,
  saetzeAusBrutto,
  steuerKorrektur,
  summenProbe,
  type Position,
} from "./beleg-positionen.ts";

/*
 * Telefonrechnung aus #1914/#1975: Internet 33,60 € und Telefon 8,53 € netto zu 19 %, zusammen 42,13 € netto und
 * 8,01 € Steuer aus 50,14 € brutto. Internet ist zu 25 % privat, Telefon zu 40 %. Betrieblich bleiben 30,32 € netto
 * und 5,76 € Vorsteuer; die Entnahme ist 11,81 € netto und 2,25 € Steuer, also 14,06 € brutto.
 */
const internet: Position = { kategorie: "internet", rate: 1900, net: 3_360, beschreibung: "Internet" };
const telefon: Position = { kategorie: "telefon", rate: 1900, net: 853 };
const telefonSteuer = [{ rate: 1900, base: 4_213, tax: 801 }];
const internetTeile = privatanteilAbspalten(internet, 25);
const telefonTeile = privatanteilAbspalten(telefon, 40);
const telefonrechnung: Position[] = [internetTeile.betrieblich, telefonTeile.betrieblich, internetTeile.privat, telefonTeile.privat];

describe("betrieblicher Teil je Position", () => {
  it("rechnet die Telefonrechnung centgenau in betrieblich und Entnahme", () => {
    const summen = positionenSummen(telefonrechnung, telefonSteuer);
    expect(summen.saetze).toEqual([{ rate: 1900, base: 3_032, tax: 576 }]);
    expect(summen.net).toBe(3_032);
    expect(summen.tax).toBe(576);
    expect(summen.gross).toBe(3_608);
    expect(summen.privat).toEqual({ net: 1_181, tax: 225, gross: 1_406, saetze: [{ rate: 1900, base: 1_181, tax: 225 }] });
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

  it("rundet betrieblich und rechnet das Private als Differenz, damit kein Cent verloren geht", () => {
    // 3,34 € zu 25 %: beide Hälften enden auf 0,5 Cent. Getrennt gerundet ergäben sich 2,51 € und 0,84 €, zusammen
    // 3,35 €; mit der Differenz bleiben es 2,51 € und 0,83 €, zusammen genau 3,34 €.
    const { betrieblich, privat } = privatanteilAbspalten({ kategorie: "telefon", rate: 1900, net: 334 }, 25);
    expect(betrieblich.net).toBe(251);
    expect(privat.net).toBe(83);
    expect(betrieblich.net + privat.net).toBe(334);
  });

  it("lässt das Konto nur am betrieblichen Teil und nimmt sonst die Kategorie in die Beschreibung", () => {
    const { betrieblich, privat } = privatanteilAbspalten({ kategorie: "telefon", rate: 1900, net: 853, konto: "4920" }, 40);
    expect(betrieblich).toMatchObject({ net: 512, konto: "4920" });
    expect(privat).toEqual({ kategorie: "privatentnahme", rate: 1900, net: 341, beschreibung: "40 % von telefon" });
  });

  it("rechnet die Entnahme nicht nach, wenn sich die Ausgangsposition später ändert", () => {
    const { privat } = privatanteilAbspalten(internet, 25);
    const summen = positionenSummen([{ ...internet, net: 4_200 }, privat], [{ rate: 1900, base: 5_040, tax: 958 }]);
    expect(summen.zeilen[1]).toMatchObject({ net: 0, tax: 0, privatNet: 840, privatTax: 160 });
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

  it("korrigiert die Steuer auf den Betrag der Rechnung und weist Unsinn ab", () => {
    // 42,13 € netto zu 19 % wären 8,00 €; die Rechnung weist 8,01 € aus
    const satz = { rate: 1900, base: 4_213, tax: 800 };
    expect(steuerKorrektur(satz, 801)).toEqual({ rate: 1900, base: 4_213, tax: 801 });
    expect(steuerKorrektur(satz, -1)).toBeNull();
    expect(steuerKorrektur(satz, 5_014)).toBeNull();
    expect(steuerKorrektur(satz, 5_013)).not.toBeNull();
  });

  it("summiert zwei Steuersätze getrennt und legt den Rest auf die größte Position", () => {
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
    const positionen = [...telefonrechnung, netflix];
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
});
