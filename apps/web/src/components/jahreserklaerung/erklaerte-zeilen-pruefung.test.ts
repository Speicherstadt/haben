import { amountError } from "@haben/core";
import { describe, expect, it } from "vitest";
import { erklaerteZeilen } from "./erklaerte-zeilen-pruefung.ts";

// #1270: Ein ungültiger Wert fällt beim Speichern nicht still weg; er meldet sich am Feld, und es wird nichts gespeichert
describe("Zeilenwerte aus dem Übermittlungsprotokoll", () => {
  const felder = [{ field: "gewinn" }, { field: "ausgaben" }, { field: "einlagen" }];
  const meldung = amountError("den Betrag der Zeile", 123_456, { optional: true });

  it("liest die ausgefüllten Felder, auch 0 und negative Beträge; leere bleiben weg", () => {
    expect(erklaerteZeilen(felder, { gewinn: "1.234,56", ausgaben: "0", einlagen: "  " })).toEqual({
      zeilen: [
        { field: "gewinn", amount: 123_456 },
        { field: "ausgaben", amount: 0 },
      ],
      fehler: { gewinn: null, ausgaben: null, einlagen: null },
      eingetragen: 2,
    });
    expect(erklaerteZeilen(felder, { gewinn: "-500" }).zeilen).toEqual([{ field: "gewinn", amount: -50_000 }]);
  });

  it("meldet einen nicht lesbaren Wert am Feld und zählt ihn als eingetragen", () => {
    const ergebnis = erklaerteZeilen(felder, { gewinn: "1.234,56", ausgaben: "12€50" });
    expect(ergebnis.fehler).toEqual({ gewinn: null, ausgaben: meldung, einlagen: null });
    expect(ergebnis.eingetragen).toBe(2);
  });
});
