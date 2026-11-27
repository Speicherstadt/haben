import { describe, expect, it } from "vitest";
import { belegPrivat, betrieblichNetto, betrieblichSteuer, hatEntnahme, type Anteilszeile } from "./beleg-anteile.ts";
import { belegAnteile, betrieblicherAnteil, hatPrivatanteil, privaterAnteil } from "./beleg-anteile.ts";

describe("Anteile eines Belegs", () => {
  it("teilt centgenau in betrieblich und privat, gerundet wie beim Buchen", () => {
    expect(belegAnteile(4_999, 20)).toEqual({ business: 3_999, private: 1_000 });
    expect(belegAnteile(12_345, 19)).toEqual({ business: 9_999, private: 2_346 });
    expect(belegAnteile(10_000, 2.5)).toEqual({ business: 9_750, private: 250 });
    // 25 % von 10 ct sind 2,5 → privater Teil gerundet 3, betrieblich 7 (nicht umgekehrt)
    expect(belegAnteile(10, 25)).toEqual({ business: 7, private: 3 });
    expect(belegAnteile(-1_000, 25)).toEqual({ business: -750, private: -250 });
    for (const [betrag, prozent] of [
      [0, 0],
      [1, 33.33],
      [853, 40],
      [50_000_000, 99.99],
      [-777, 7.5],
    ] as const) {
      const { business, private: privat } = belegAnteile(betrag, prozent);
      expect(business + privat).toBe(betrag);
    }
  });

  it("betrieblicher Teil: ohne Anteil der ganze Betrag, bei 100 % nichts", () => {
    expect(betrieblicherAnteil(4_999, 0)).toBe(4_999);
    expect(betrieblicherAnteil(853, 40)).toBe(512);
    expect(betrieblicherAnteil(1_000, 100)).toBe(0);
    expect(betrieblicherAnteil(-853, 40)).toBe(-512);
    // Der private Teil wird gerundet, der betriebliche ist die Differenz: 33 % von 350 ct sind 115,5 → 116
    // privat, betrieblich 234. Direkt gerundet wären es 234,5 → 235 (Fehler aus #1981).
    expect(betrieblicherAnteil(350, 33)).toBe(234);
    expect(betrieblicherAnteil(10, 25)).toBe(7);
  });

  it("privater Teil: ohne Anteil nichts, sonst die Entnahme", () => {
    expect(privaterAnteil(4_999, 0)).toBe(0);
    expect(privaterAnteil(853, 40)).toBe(341);
    expect(privaterAnteil(1_000, 100)).toBe(1_000);
    expect(privaterAnteil(-853, 40)).toBe(-341);
  });

  it("hatPrivatanteil unterscheidet 0 von jedem gesetzten Wert", () => {
    expect(hatPrivatanteil(0)).toBe(false);
    expect(hatPrivatanteil(null)).toBe(false);
    expect(hatPrivatanteil(undefined)).toBe(false);
    expect(hatPrivatanteil(1)).toBe(true);
    expect(hatPrivatanteil(100)).toBe(true);
  });

  it("liest ein Beleg mit Entnahmezeilen aus den Zeilen statt aus dem Prozentwert (#1975)", () => {
    // Telefon-Beispiel des Issues: Internet 33,60 € netto zu 25 % privat, Telefon 8,53 € netto zu 40 % privat
    const zeilen: Anteilszeile[] = [
      { category: "internet", taxRate: 1900, net: 2_520, tax: 479 },
      { category: "privatentnahme", taxRate: 1900, net: 840, tax: 160 },
      { category: "telefon", taxRate: 1900, net: 512, tax: 97 },
      { category: "privatentnahme", taxRate: 1900, net: 341, tax: 65 },
    ];
    const privat = belegPrivat(0, zeilen);
    expect(privat.entnahme).toEqual([{ rate: 1900, base: 1_181, tax: 225 }]);
    expect(privat.privateShare).toBe(0);
    expect(hatEntnahme(privat)).toBe(true);
    expect(betrieblichNetto(privat, 1900, 4_213)).toBe(3_032);
    expect(betrieblichSteuer(privat, 1900, 801)).toBe(576);
    // eine Teilzahlung trägt ihren Anteil an der Entnahme mit
    expect(betrieblichSteuer(privat, 1900, 400, 801)).toBe(400 - 112);
  });

  it("ohne Entnahmezeilen gilt der Prozentwert am Beleg wie bisher", () => {
    const privat = belegPrivat(25);
    expect(hatEntnahme(privat)).toBe(false);
    expect(betrieblichNetto(privat, 1900, 2_000)).toBe(1_500);
    expect(betrieblichSteuer(privat, 1900, 380)).toBe(285);
    expect(betrieblichSteuer(belegPrivat(100), 1900, 380)).toBe(0);
  });

  it("hatPrivatanteil erkennt auch eine Entnahmezeile ohne Prozentwert am Beleg", () => {
    expect(hatPrivatanteil(0, [])).toBe(false);
    expect(hatPrivatanteil(0, [{ category: "telefon", taxRate: 1900, net: 100, tax: 19 }])).toBe(false);
    expect(hatPrivatanteil(0, [{ category: "privatentnahme", taxRate: 1900, net: 100, tax: 19 }])).toBe(true);
  });
});
