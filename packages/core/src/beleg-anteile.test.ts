import { describe, expect, it } from "vitest";
import {
  betrieblicheSaetze,
  betrieblicheSummen,
  betrieblicheZahlungsanteile,
  betrieblicheZeile,
  privaterAnteil,
  type BelegAnteilZeile,
} from "./beleg-anteile.ts";

/*
 * Beispiel aus #1914: Internet 33,60 € und Telefon 8,53 € netto zu 19 % (8,01 € Steuer aus 50,14 € brutto), Internet 25 %
 * privat, Telefon 40 % privat. Betrieblich bleiben 30,32 € netto und 5,76 € Vorsteuer, die Entnahme ist 14,06 €.
 */
const zeilen: BelegAnteilZeile[] = [
  { rate: 1900, base: 3_360, tax: 639, privateShare: 25 },
  { rate: 1900, base: 853, tax: 162, privateShare: 40 },
];

describe("betrieblicher Anteil je Zeile", () => {
  it("liefert betriebliches Netto und Steuer je Satz centgenau", () => {
    expect(betrieblicheSaetze(zeilen)).toEqual([{ rate: 1900, base: 3_032, tax: 576 }]);
    expect(betrieblicheSummen(zeilen)).toEqual({ net: 3_032, tax: 576, gross: 3_608, privatePart: 1_406 });
  });

  it("trifft mit vollem Betrag genau die betrieblichen Beträge der Zeilen", () => {
    // 3.032 + 576 = 3.608 betrieblich, 1.406 privat, zusammen 5.014 brutto
    expect(betrieblicheZahlungsanteile(zeilen, 5_014)).toEqual([{ rate: 1900, base: 3_032, tax: 576 }]);
    expect(betrieblicheZahlungsanteile(zeilen, 0)).toEqual([{ rate: 1900, base: 0, tax: 0 }]);
  });

  it("ergänzen sich über Teilzahlungen zum vollen Betrag, ohne Cent zu verlieren", () => {
    const erste = betrieblicheZahlungsanteile(zeilen, 2_507)[0]!;
    const voll = betrieblicheZahlungsanteile(zeilen, 5_014)[0]!;
    // Die zweite Zahlung ist der Unterschied zum kumulierten Ziel
    expect(erste.base + (voll.base - erste.base)).toBe(3_032);
    expect(erste.tax + (voll.tax - erste.tax)).toBe(576);
  });

  it("ohne Privatanteil bleibt der Beleg, wie er ist", () => {
    const ohne = zeilen.map((z) => ({ ...z, privateShare: 0 }));
    expect(betrieblicheSaetze(ohne)).toEqual([{ rate: 1900, base: 4_213, tax: 801 }]);
    expect(betrieblicheSummen(ohne)).toEqual({ net: 4_213, tax: 801, gross: 5_014, privatePart: 0 });
  });
});

/*
 * Telekom-Rechnung aus #1926: Internet 33,60 € netto zu 19 % mit 25 % privat, Netflix 10,92 € netto zu 19 % mit
 * 12,99 € brutto vollständig privat. Betrieblich bleiben 25,20 € netto und 4,79 € Vorsteuer, die Entnahme ist 22,99 €.
 */
const internet: BelegAnteilZeile = { rate: 1900, base: 3_360, tax: 639, privateShare: 25 };
const netflix: BelegAnteilZeile = { rate: 1900, base: 1_092, tax: 207, privateShare: 0, privateAmount: 1_299, privateAmountBasis: "brutto" };

describe("Privatbetrag je Zeile (#1926)", () => {
  it("nimmt einen Netto-Betrag unverändert als privaten Anteil", () => {
    const zeile: BelegAnteilZeile = { rate: 1900, base: 3_360, tax: 639, privateShare: 0, privateAmount: 1_000, privateAmountBasis: "netto" };
    expect(privaterAnteil(zeile)).toEqual({ net: 1_000, tax: 190 });
    expect(betrieblicheZeile(zeile)).toEqual({ rate: 1900, base: 2_360, tax: 449, privatePart: 1_190 });
  });

  it("rechnet einen Brutto-Betrag zu 19 % in Netto und Steuer", () => {
    // 12,99 € brutto enthalten 2,07 € Steuer, privat sind 10,92 € netto
    expect(privaterAnteil(netflix)).toEqual({ net: 1_092, tax: 207 });
    expect(betrieblicheZeile(netflix)).toEqual({ rate: 1900, base: 0, tax: 0, privatePart: 1_299 });
  });

  it("begrenzt den privaten Anteil auf das Netto der Zeile", () => {
    const zeile: BelegAnteilZeile = { rate: 1900, base: 500, tax: 95, privateShare: 0, privateAmount: 1_000, privateAmountBasis: "netto" };
    expect(privaterAnteil(zeile)).toEqual({ net: 500, tax: 95 });
    expect(betrieblicheSummen([zeile])).toEqual({ net: 0, tax: 0, gross: 0, privatePart: 595 });
  });

  it("gibt dem Betrag Vorrang vor einem gleichzeitig gesetzten Prozentwert", () => {
    const beides: BelegAnteilZeile = { ...netflix, privateShare: 50 };
    expect(betrieblicheZeile(beides)).toEqual(betrieblicheZeile(netflix));
  });

  it("mischt Prozent- und Betragszeile auf einem Beleg", () => {
    expect(betrieblicheSaetze([internet, netflix])).toEqual([{ rate: 1900, base: 2_520, tax: 479 }]);
    expect(betrieblicheSummen([internet, netflix])).toEqual({ net: 2_520, tax: 479, gross: 2_999, privatePart: 2_299 });
  });

  it("trifft die betrieblichen Beträge auch über Teilzahlungen", () => {
    const voll = betrieblicheZahlungsanteile([internet, netflix], 5_298);
    expect(voll).toEqual([{ rate: 1900, base: 2_520, tax: 479 }]);
    expect(betrieblicheZahlungsanteile([internet, netflix], 0)).toEqual([{ rate: 1900, base: 0, tax: 0 }]);
    // Kumuliert: die zweite Zahlung ist der Unterschied zum Ziel, zusammen genau der volle betriebliche Betrag
    const erste = betrieblicheZahlungsanteile([internet, netflix], 2_649)[0]!;
    expect(erste.base + (voll[0]!.base - erste.base)).toBe(2_520);
    expect(erste.tax + (voll[0]!.tax - erste.tax)).toBe(479);
  });
});
