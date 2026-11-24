import { describe, expect, it } from "vitest";
import { kz48Einordnen } from "./kz48.ts";

// #1268: Die Voranmeldung zählt Umsätze als Kleinunternehmer in Kz 48; in die Zeilen 46/47 der Jahreserklärung (§ 4 UStG)
// gehören sie nicht und sind auch kein Rest ohne Quelle.
describe("kz48Einordnen mit Umsätzen als Kleinunternehmer", () => {
  it("der Anteil der Kleinunternehmer-Umsätze an Kz 48 wird weder eingeordnet noch gesperrt", () => {
    const ergebnis = kz48Einordnen([{ kz48: 80_000, kz48Kleinunternehmer: 80_000, revenue: [] }], 2026);
    expect(ergebnis).toEqual({ zeile46: 0, zeile47: 0, nummern: "", gesperrt: [] });
  });

  it("ein Rest ohne Quelle daneben bleibt gesperrt", () => {
    const ergebnis = kz48Einordnen([{ kz48: 100_000, kz48Kleinunternehmer: 80_000, revenue: [] }], 2026);
    expect(ergebnis.gesperrt).toEqual([{ quelle: "Buchungen ohne Rechnung 01/2026", text: "", betrag: 20_000, grund: "nummer" }]);
  });
});
