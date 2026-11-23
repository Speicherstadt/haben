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

  it("verlangt eine Begründung mit mindestens 10 Zeichen", () => {
    expect(manuellFehler({ kz81: 100 }, "zu kurz").reason).toBe(
      "Begründe die Abweichung mit mindestens 10 Zeichen, etwa „Zahlung vom 30.09. erst im Oktober zugeordnet“.",
    );
    expect(manuellFehler({ kz81: 100 }, "  1234567890  ").reason).toBeNull();
  });
});
