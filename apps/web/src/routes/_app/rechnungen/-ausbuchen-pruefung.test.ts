import { amountError } from "@haben/core";
import { describe, expect, it } from "vitest";
import { ausbuchenFehler } from "./-ausbuchen-pruefung.ts";

// #1270: „Ausbuchen“ prüft beim Absenden und meldet am Feld, statt den Knopf zu sperren
describe("Prüfung beim Ausbuchen eines Rests", () => {
  const offen = 59_500;
  const meldung = amountError("einen Betrag über 0 bis zum offenen Rest", offen);

  it("meldet einen nicht lesbaren Betrag, 0, einen negativen und einen über dem offenen Rest", () => {
    for (const betrag of ["12€50", "", "0", "-10", "595,01"]) expect(ausbuchenFehler({ betrag, offen, datum: "2026-11-23" }).betrag, betrag).toBe(meldung);
  });

  it("nimmt Beträge über 0 bis zum offenen Rest an", () => {
    for (const betrag of ["0,01", "100", "595,00"]) expect(ausbuchenFehler({ betrag, offen, datum: "2026-11-23" }).betrag, betrag).toBeNull();
  });

  it("verlangt das Datum", () => {
    expect(ausbuchenFehler({ betrag: "100", offen, datum: "" }).datum).toBe("Wähle den Tag der Ausbuchung.");
  });
});
