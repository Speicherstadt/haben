import { describe, expect, it } from "vitest";
import {
  betrieblichePosition,
  positionenSummen,
  privaterAnteil,
  privatPositionAusProzent,
  privatPositionFesterBetrag,
  privatPositionNachrechnen,
  steuerKorrektur,
  type BelegPosition,
} from "./beleg-positionen.ts";

/*
 * Telefonrechnung aus #1914/#1975: Internet 33,60 € und Telefon 8,53 € netto zu 19 % (8,01 € Steuer aus 50,14 €
 * brutto), Internet 25 % privat, Telefon 40 % privat. Betrieblich bleiben 30,32 € netto und 5,76 € Vorsteuer; die
 * Entnahme ist 11,81 € netto und 2,25 € Steuer, also 14,06 € brutto (10,00 € plus 4,06 €).
 */
const internet: BelegPosition = { rate: 1900, net: 3_360, tax: 639, privateShare: 25, kategorie: "internet", beschreibung: "Internet" };
const telefon: BelegPosition = { rate: 1900, net: 853, tax: 162, privateShare: 40 };
const telefonrechnung: BelegPosition[] = [internet, telefon];

describe("betrieblicher Teil je Position", () => {
  it("rechnet die Telefonrechnung centgenau in betrieblich und Entnahme", () => {
    expect(betrieblichePosition(internet)).toEqual({ net: 2_520, tax: 479 });
    expect(betrieblichePosition(telefon)).toEqual({ net: 512, tax: 97 });
    const summen = positionenSummen(telefonrechnung);
    expect(summen.saetze).toEqual([{ rate: 1900, base: 3_032, tax: 576 }]);
    expect(summen.net).toBe(3_032);
    expect(summen.tax).toBe(576);
    expect(summen.gross).toBe(3_608);
    expect(summen.privat).toEqual({ net: 1_181, tax: 225, gross: 1_406 });
  });

  it("lässt eine Rechnung ohne Privatanteil, wie sie ist", () => {
    const ohne: BelegPosition[] = [{ rate: 1900, net: 4_213, tax: 801 }];
    expect(betrieblichePosition(ohne[0]!)).toEqual({ net: 4_213, tax: 801 });
    expect(positionenSummen(ohne)).toMatchObject({ net: 4_213, tax: 801, gross: 5_014 });
    expect(positionenSummen(ohne).privat).toEqual({ net: 0, tax: 0, gross: 0 });
  });

  it("gibt dem festen Betrag Vorrang vor einem Prozentwert", () => {
    const beides: BelegPosition = { ...internet, privateAmount: 1_000, privateAmountBasis: "netto" };
    expect(privaterAnteil(beides)).toEqual({ net: 1_000, tax: 190 });
    expect(betrieblichePosition(beides)).toEqual({ net: 2_360, tax: 449 });
  });

  it("begrenzt einen festen Betrag auf Netto und Steuer der Position", () => {
    const klein: BelegPosition = { rate: 1900, net: 500, tax: 95, privateAmount: 1_000, privateAmountBasis: "netto" };
    expect(privaterAnteil(klein)).toEqual({ net: 500, tax: 95 });
    expect(betrieblichePosition(klein)).toEqual({ net: 0, tax: 0 });
  });
});

describe("Privat als eigene Position", () => {
  it("legt aus 25 % auf Internet eine Privat-Position an und rechnet sie nach", () => {
    const privat = privatPositionAusProzent(internet, 25, 0);
    expect(privat).toMatchObject({
      rate: 1900,
      net: 840,
      tax: 160,
      privat: true,
      privateShare: 25,
      privateOf: 0,
      beschreibung: "25 % von Internet",
    });
    expect(betrieblichePosition(privat)).toEqual({ net: 0, tax: 0 });

    // Internet ändert sich: 42,00 € netto zu 19 % sind 7,98 € Steuer
    const geaendert: BelegPosition = { rate: 1900, net: 4_200, tax: 798 };
    const nach = privatPositionNachrechnen(privat, geaendert);
    expect(nach).toMatchObject({ net: 1_050, tax: 200, privateShare: 25, privateOf: 0 });
    expect(betrieblichePosition(nach!)).toEqual({ net: 0, tax: 0 });
  });

  it("gibt null zurück, wenn die Ausgangsposition wegfällt", () => {
    const privat = privatPositionAusProzent(internet, 25, 0);
    expect(privatPositionNachrechnen(privat, null)).toBeNull();
    expect(privatPositionNachrechnen(privat, undefined)).toBeNull();
  });

  it("bucht Netflix als feste Privat-Position ohne betrieblichen Anteil", () => {
    const netflix = privatPositionFesterBetrag(1_299, "brutto", 1900);
    expect(netflix).toMatchObject({ rate: 1900, net: 1_092, tax: 207, privat: true, privateAmount: 1_299, privateAmountBasis: "brutto" });
    expect(betrieblichePosition(netflix)).toEqual({ net: 0, tax: 0 });
    expect(positionenSummen([internet, netflix]).saetze).toEqual([{ rate: 1900, base: 2_520, tax: 479 }]);
    expect(positionenSummen([internet, netflix]).privat).toEqual({ net: 1_932, tax: 367, gross: 2_299 });
  });

  it("nimmt einen festen Betrag auf Netto-Basis unverändert", () => {
    const netto = privatPositionFesterBetrag(1_000, "netto", 1900);
    expect(netto).toMatchObject({ net: 1_000, tax: 190, privat: true, privateAmountBasis: "netto" });
    expect(betrieblichePosition(netto)).toEqual({ net: 0, tax: 0 });
  });
});

describe("Steuer je Satz", () => {
  it("korrigiert die Steuer auf den Betrag der Rechnung und weist Unsinn ab", () => {
    // 42,13 € netto zu 19 % wären 8,00 €; die Rechnung weist 8,01 € aus
    const position: BelegPosition = { rate: 1900, net: 4_213, tax: 800 };
    const korrigiert = steuerKorrektur(position, 801);
    expect(korrigiert).toMatchObject({ net: 4_213, tax: 801 });
    expect(steuerKorrektur(position, -1)).toBeNull();
    expect(steuerKorrektur(position, 5_014)).toBeNull();
    expect(steuerKorrektur(position, 5_013)).not.toBeNull();
  });

  it("summiert zwei Steuersätze getrennt und zusammen", () => {
    const gemischt: BelegPosition[] = [
      { rate: 1900, net: 3_000, tax: 570 },
      { rate: 1900, net: 10_000, tax: 1_900 },
      { rate: 700, net: 5_000, tax: 350 },
    ];
    const summen = positionenSummen(gemischt);
    expect(summen.saetze).toEqual([
      { rate: 1900, base: 13_000, tax: 2_470 },
      { rate: 700, base: 5_000, tax: 350 },
    ]);
    expect(summen.net).toBe(18_000);
    expect(summen.tax).toBe(2_820);
    expect(summen.gross).toBe(20_820);
  });

  it("legt den Rundungsrest auf die größte Position des Satzes", () => {
    const gemischt: BelegPosition[] = [
      { rate: 1900, net: 3_000, tax: 570 },
      { rate: 1900, net: 10_000, tax: 1_900 },
      { rate: 700, net: 5_000, tax: 350 },
    ];
    // Die Rechnung weist für 19 % einen Cent mehr aus, als die Positionen ergeben
    const summen = positionenSummen(gemischt, [
      { rate: 1900, base: 13_000, tax: 2_471 },
      { rate: 700, base: 5_000, tax: 350 },
    ]);
    expect(summen.saetze).toEqual([
      { rate: 1900, base: 13_000, tax: 2_471 },
      { rate: 700, base: 5_000, tax: 350 },
    ]);
    // Nicht die erste, sondern die betragsmäßig größte 19-%-Position trägt den Cent
    expect(summen.zeilen[0]).toEqual({ index: 0, rate: 1900, net: 3_000, tax: 570 });
    expect(summen.zeilen[1]).toEqual({ index: 1, rate: 1900, net: 10_000, tax: 1_901 });
    expect(summen.zeilen[2]).toEqual({ index: 2, rate: 700, net: 5_000, tax: 350 });
  });
});

describe("Summenprobe", () => {
  it("betrieblich plus privat ergibt genau die Positionen", () => {
    const positionen = [...telefonrechnung, privatPositionFesterBetrag(1_299, "brutto", 1900)];
    const summen = positionenSummen(positionen);
    const netto = positionen.reduce((s, position) => s + position.net, 0);
    const steuer = positionen.reduce((s, position) => s + position.tax, 0);
    expect(summen.net + summen.privat.net).toBe(netto);
    expect(summen.tax + summen.privat.tax).toBe(steuer);
    expect(summen.gross + summen.privat.gross).toBe(netto + steuer);
    expect(summen.privat).toEqual({ net: 2_273, tax: 432, gross: 2_705 });
  });
});
