import { describe, expect, it } from "vitest";
import { betrieblicheSaetze, betrieblicheSummen, betrieblicheZahlungsanteile, type BelegAnteilZeile } from "./beleg-anteile.ts";

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
