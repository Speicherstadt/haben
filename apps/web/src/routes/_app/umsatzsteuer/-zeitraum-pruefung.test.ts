import { amountError } from "@haben/core";
import { describe, expect, it } from "vitest";
import { manuellFehler } from "./-zeitraum-pruefung.ts";

// #1270: „Entwurf speichern“ prüft die Kennzahlen von Hand und die Begründung beim Absenden, statt gesperrt zu sein
describe("Prüfung der Voranmeldung von Hand", () => {
  const begruendung = "Zahlung vom 30.09. erst im Oktober zugeordnet";

  it("meldet einen nicht lesbaren Betrag je Kennzahl mit der Meldung aus amountError", () => {
    expect(manuellFehler({ kz81: null, kz86: -50_000 }, begruendung)).toEqual({
      kz81: amountError("den Betrag der Kennzahl", 123_456),
      kz86: null,
      reason: null,
    });
  });

  it("hält die Grenze von saveVatDraft ein, ±1.000.000.000,00 € je Kennzahl", () => {
    const zuGross = "Trag einen Betrag von -1.000.000.000,00 bis 1.000.000.000,00 ein, etwa 1.234,56.";
    expect(manuellFehler({ kz81: 1_000_000_000_01, kz86: -1_000_000_000_01, kz66: 1_000_000_000_00, kz67: -1_000_000_000_00 }, begruendung)).toEqual({
      kz81: zuGross,
      kz86: zuGross,
      kz66: null,
      kz67: null,
      reason: null,
    });
  });

  // #1267: saveVatDraft lehnt eine negative Kz 50 ab (im ERiC-Schema GanzzahlNichtNeg), das Feld meldet es vorher
  it("meldet eine negative Kz 50 am Feld, andere Kennzahlen dürfen negativ sein", () => {
    expect(manuellFehler({ kz50: -1, kz81: -1, kz86: 0 }, begruendung)).toEqual({
      kz50: "Trag einen Betrag von 0,00 bis 1.000.000.000,00 ein, etwa 1.234,56.",
      kz81: null,
      kz86: null,
      reason: null,
    });
    expect(manuellFehler({ kz50: 0 }, begruendung).kz50).toBeNull();
    expect(manuellFehler({ kz50: 1_000_000_000_01 }, begruendung).kz50).toBe("Trag einen Betrag von 0,00 bis 1.000.000.000,00 ein, etwa 1.234,56.");
  });

  it("verlangt eine Begründung mit mindestens 10 Zeichen", () => {
    expect(manuellFehler({ kz81: 100 }, "zu kurz").reason).toBe(
      "Begründe die Abweichung mit mindestens 10 Zeichen, etwa „Zahlung vom 30.09. erst im Oktober zugeordnet“.",
    );
    expect(manuellFehler({ kz81: 100 }, "  1234567890  ").reason).toBeNull();
  });
});
