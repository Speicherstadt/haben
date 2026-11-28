import { describe, expect, it, vi } from "vitest";
import { mindestbestandEingabe } from "./MindestbestandKarte.tsx";

vi.mock("../server/functions/liquiditaet.ts", () => ({}));

describe("Mindestbestand: Eingabe (#1381)", () => {
  it("leer heißt kein Mindestbestand, ein Betrag ab 0 € gilt", () => {
    expect(mindestbestandEingabe("  ")).toEqual({ betrag: null, fehler: null });
    expect(mindestbestandEingabe("5.000,00")).toEqual({ betrag: 500_000, fehler: null });
    expect(mindestbestandEingabe("0")).toEqual({ betrag: 0, fehler: null });
  });

  it("kein Betrag oder ein negativer meldet das Feld", () => {
    const fehler = "Trag einen Betrag ab 0 € ein, etwa 5.000,00, oder lass das Feld leer.";
    expect(mindestbestandEingabe("viel")).toEqual({ betrag: null, fehler });
    expect(mindestbestandEingabe("-1,00")).toEqual({ betrag: null, fehler });
  });
});
