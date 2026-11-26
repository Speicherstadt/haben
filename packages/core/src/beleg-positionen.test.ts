import { describe, expect, it } from "vitest";
import {
  positionenSummen,
  privatPositionAusProzent,
  privatPositionFesterBetrag,
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
const internet: Position = { kategorie: "internet", rate: 1900, net: 3_360, art: "normal", beschreibung: "Internet" };
const telefon: Position = { kategorie: "telefon", rate: 1900, net: 853, art: "normal" };
const telefonSteuer = [{ rate: 1900, base: 4_213, tax: 801 }];
const telefonrechnung: Position[] = [internet, telefon, privatPositionAusProzent(internet, 25, 0), privatPositionAusProzent(telefon, 40, 1)];

describe("betrieblicher Teil je Position", () => {
  it("rechnet die Telefonrechnung centgenau in betrieblich und Entnahme", () => {
    const summen = positionenSummen(telefonrechnung, telefonSteuer);
    expect(summen.saetze).toEqual([{ rate: 1900, base: 3_032, tax: 576 }]);
    expect(summen.net).toBe(3_032);
    expect(summen.tax).toBe(576);
    expect(summen.gross).toBe(3_608);
    expect(summen.privat).toEqual({ net: 1_181, tax: 225, gross: 1_406, saetze: [{ rate: 1900, base: 1_181, tax: 225 }] });
    // Die Privatpositionen tragen ihre Entnahme, betrieblich bleibt bei ihnen exakt 0
    expect(summen.zeilen[2]).toMatchObject({ net: 0, tax: 0, privatNet: 840, privatTax: 160 });
    expect(summen.zeilen[3]).toMatchObject({ net: 0, tax: 0, privatNet: 341, privatTax: 65 });
  });

  it("lässt eine Rechnung ohne Privatanteil, wie sie ist", () => {
    const ohne: Position[] = [{ kategorie: "hardware", rate: 1900, net: 4_213, art: "normal" }];
    const summen = positionenSummen(ohne, [{ rate: 1900, base: 4_213, tax: 801 }]);
    expect(summen).toMatchObject({ net: 4_213, tax: 801, gross: 5_014 });
    expect(summen.privat).toEqual({ net: 0, tax: 0, gross: 0, saetze: [] });
  });

  it("nimmt einen festen Betrag auf Netto-Basis unverändert und ganz als Entnahme", () => {
    const netto = privatPositionFesterBetrag(1_000, "netto", 1900);
    expect(netto).toMatchObject({ net: 1_000, art: "privat", privateAmount: 1_000, privateAmountBasis: "netto" });
    const summen = positionenSummen([netto], [{ rate: 1900, base: 1_000, tax: 190 }]);
    expect(summen.net).toBe(0);
    expect(summen.tax).toBe(0);
    expect(summen.privat).toEqual({ net: 1_000, tax: 190, gross: 1_190, saetze: [{ rate: 1900, base: 1_000, tax: 190 }] });
  });

  it("bucht 12,99 € brutto als eigene Privat-Position ohne betrieblichen Anteil", () => {
    const netflix = privatPositionFesterBetrag(1_299, "brutto", 1900);
    expect(netflix).toMatchObject({ net: 1_092, art: "privat", privateAmount: 1_299, privateAmountBasis: "brutto" });
    const summen = positionenSummen([netflix], [{ rate: 1900, base: 1_092, tax: 207 }]);
    expect(summen.zeilen[0]).toMatchObject({ net: 0, tax: 0, privatNet: 1_092, privatTax: 207 });
    expect(summen.privat).toEqual({ net: 1_092, tax: 207, gross: 1_299, saetze: [{ rate: 1900, base: 1_092, tax: 207 }] });
  });
});

describe("Privat als eigene Position", () => {
  it("legt aus 25 % auf Internet eine Privat-Position an", () => {
    const privat = privatPositionAusProzent(internet, 25, 0);
    expect(privat).toMatchObject({
      kategorie: "internet",
      rate: 1900,
      net: 840,
      art: "privat",
      privatVon: 0,
      prozent: 25,
      beschreibung: "25 % von Internet",
    });
  });

  it("rechnet die Privat-Position aus der geänderten Ausgangsposition neu", () => {
    // Internet ändert sich: 42,00 € netto zu 19 % sind 7,98 € Steuer; 25 % davon sind 10,50 € und 2,00 €
    const geaendert: Position[] = [{ ...internet, net: 4_200 }, privatPositionAusProzent(internet, 25, 0)];
    const summen = positionenSummen(geaendert, [{ rate: 1900, base: 4_200, tax: 798 }]);
    expect(summen.zeilen[1]).toMatchObject({ net: 0, tax: 0, privatNet: 1_050, privatTax: 200 });
    expect(summen).toMatchObject({ net: 3_150, tax: 598 });
  });

  it("weist eine Privat-Position ohne normale Ausgangsposition ab", () => {
    const verwaist: Position = { ...privatPositionAusProzent(internet, 25, 0), privatVon: 7 };
    expect(() => positionenSummen([verwaist], telefonSteuer)).toThrow(RangeError);
    const aufSichSelbst: Position = { ...privatPositionAusProzent(internet, 25, 0), privatVon: 0 };
    expect(() => positionenSummen([aufSichSelbst], telefonSteuer)).toThrow(/keine normale Ausgangsposition/);
  });
});

describe("Steuer je Satz", () => {
  it("verteilt die Steuer des Satzes über allocateSplitTax und summiert exakt 8,01 €", () => {
    const positionen: Position[] = [
      { kategorie: "ware", rate: 1900, net: 1_000, art: "normal" },
      { kategorie: "ware", rate: 1900, net: 1_000, art: "normal" },
      { kategorie: "ware", rate: 1900, net: 2_213, art: "normal" },
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
        { kategorie: "ware", rate: 1900, net: 3_000, art: "normal" },
        { kategorie: "versand", rate: 1900, net: 1_213, art: "normal" },
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
      { kategorie: "ware", rate: 1900, net: 3_000, art: "normal" },
      { kategorie: "ware", rate: 1900, net: 10_000, art: "normal" },
      { kategorie: "buch", rate: 700, net: 5_000, art: "normal" },
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
  it("weist Privat-Positionen bei GmbH und UG ab", () => {
    const privat = privatPositionFesterBetrag(1_299, "brutto", 1900);
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
    const netflix = privatPositionFesterBetrag(1_299, "brutto", 1900);
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
