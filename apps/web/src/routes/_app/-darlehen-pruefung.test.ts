import { amountError } from "@haben/core";
import { describe, expect, it } from "vitest";
import { darlehenFehler } from "./-darlehen-pruefung.ts";

// #1270: „Darlehen anlegen“ prüft beim Absenden und meldet am Feld, statt still abzubrechen
describe("Prüfung beim Anlegen eines Darlehens", () => {
  it("meldet eine nicht lesbare oder negative Restschuld mit der Meldung aus amountError", () => {
    for (const restschuld of ["12€50", "-100", "abc"])
      expect(darlehenFehler({ name: "Hausbank", restschuld, stichtag: "" }).restschuld, restschuld).toBe(
        amountError("die Restschuld", 2_500_000, { optional: true }),
      );
  });

  it("nimmt eine leere Restschuld (neues Darlehen) und lesbare Beträge an", () => {
    for (const restschuld of ["", "  ", "25.000,00", "12,50", "0"])
      expect(darlehenFehler({ name: "Hausbank", restschuld, stichtag: "2026-01-01" }).restschuld, restschuld).toBeNull();
  });

  it("verlangt einen Namen", () => {
    expect(darlehenFehler({ name: "  ", restschuld: "", stichtag: "" }).name).toBe(
      "Trag einen Namen für das Darlehen ein, etwa „Hausbank Investitionskredit“.",
    );
    expect(darlehenFehler({ name: "Hausbank", restschuld: "", stichtag: "" }).name).toBeNull();
  });

  // Der Server lehnt eine Restschuld ohne Stichtag ab (bank/darlehen.ts, createLoan); das gehört ans Feld, nicht in die Meldung danach
  it("verlangt zu einer Restschuld über 0 den Stichtag", () => {
    expect(darlehenFehler({ name: "Hausbank", restschuld: "25.000,00", stichtag: "" }).stichtag).toBe("Wähle den Stichtag der Restschuld.");
    expect(darlehenFehler({ name: "Hausbank", restschuld: "25.000,00", stichtag: "2026-01-01" }).stichtag).toBeNull();
    for (const restschuld of ["", "0", "12€50"]) expect(darlehenFehler({ name: "Hausbank", restschuld, stichtag: "" }).stichtag, restschuld).toBeNull();
  });
});
