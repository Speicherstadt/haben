import { liquiditaetsVorschau } from "@haben/core";
import { describe, expect, it, vi } from "vitest";
import { mindestbestandEingabe, speicherMeldung } from "./MindestbestandKarte.tsx";

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

  it("über 1 Mrd. € meldet das Feld, statt dass der Server die Eingabe ablehnt", () => {
    expect(mindestbestandEingabe("1.000.000.000,00")).toEqual({ betrag: 100_000_000_000, fehler: null });
    expect(mindestbestandEingabe("1.000.000.000,01")).toEqual({
      betrag: null,
      fehler: "Trag einen Betrag von 0 bis 1.000.000.000,00\u00a0€ ein, etwa 5.000,00, oder lass das Feld leer.",
    });
  });
});

describe("Mindestbestand: Meldung nach dem Speichern (#1381)", () => {
  // 8.000 € heute, am 10.12. gehen 4.000 € raus
  const vorschau = liquiditaetsVorschau({
    heute: "2026-11-20",
    horizont: "4w",
    start: 800_000,
    posten: [{ datum: "2026-12-10", betrag: 400_000, richtung: "aus", text: "Miete", quelle: { art: "dauerbeleg", id: "m" }, sicherheit: "fest" }],
  });

  it("nennt den ersten Tag im gewählten Horizont unter dem neuen Mindestbestand", () => {
    expect(speicherMeldung(500_000, vorschau)).toBe("Mindestbestand gespeichert. Der Kontostand unterschreitet ihn am 10.12.2026.");
  });

  it("sagt, wenn der Stand im Horizont darüber bleibt; 0 € warnt erst vor einem Minus", () => {
    const darueber = "Mindestbestand gespeichert. Der Kontostand bleibt im gewählten Horizont darüber.";
    expect(speicherMeldung(400_000, vorschau)).toBe(darueber);
    expect(speicherMeldung(0, vorschau)).toBe(darueber);
  });

  it("ohne bekannten Kontostand keine Aussage, leer heißt entfernt", () => {
    expect(speicherMeldung(500_000, null)).toBe("Mindestbestand gespeichert.");
    expect(speicherMeldung(null, vorschau)).toBe("Mindestbestand entfernt.");
  });
});
