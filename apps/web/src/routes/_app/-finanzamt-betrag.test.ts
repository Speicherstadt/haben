import { amountError } from "@haben/core";
import { describe, expect, it } from "vitest";
import { vorauszahlungBetrag } from "./-finanzamt-betrag.ts";

// #1270: Die Felder zur Vorauszahlung haben keinen eigenen Knopf; ein nicht lesbarer Betrag steht sofort am Feld, und der
// Antrag nennt ihn nicht
describe("Betrag der Vorauszahlung je Quartal", () => {
  const meldung = amountError("die Vorauszahlung je Quartal", 150_000, { optional: true });

  it("leer: kein Betrag, kein Fehler", () => {
    expect(vorauszahlungBetrag("  ")).toEqual({ cents: null, fehler: null });
  });

  it("lesbar: der Betrag in Cent", () => {
    expect(vorauszahlungBetrag("1.500,00")).toEqual({ cents: 150_000, fehler: null });
    expect(vorauszahlungBetrag("0")).toEqual({ cents: 0, fehler: null });
  });

  it("nicht lesbar oder negativ: kein Betrag, die Meldung aus amountError", () => {
    for (const text of ["12€50", "-100", "abc"]) expect(vorauszahlungBetrag(text), text).toEqual({ cents: null, fehler: meldung });
  });
});
