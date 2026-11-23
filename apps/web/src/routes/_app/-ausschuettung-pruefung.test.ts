import { amountError } from "@haben/core";
import { describe, expect, it } from "vitest";
import { ausschuettungFehler } from "./-ausschuettung-pruefung.ts";

// #1277: statt „Datum des Beschlusses, Geschäftsjahr und Betrag eingeben.“ je Feld eine Meldung
describe("Prüfung einer neuen Ausschüttung", () => {
  const gut = { beschluss: "2026-03-15", geschaeftsjahr: "2025", betrag: "30.000,00" };

  it("nimmt gültige Angaben an", () => {
    expect(ausschuettungFehler(gut)).toEqual({ beschluss: null, geschaeftsjahr: null, betrag: null });
  });

  it("meldet jedes Feld für sich", () => {
    expect(ausschuettungFehler({ beschluss: "", geschaeftsjahr: "", betrag: "" })).toEqual({
      beschluss: "Wähle das Datum des Beschlusses.",
      geschaeftsjahr: "Trag das Geschäftsjahr vierstellig ein, etwa 2025.",
      betrag: amountError("einen Betrag über 0", 3_000_000),
    });
  });

  it("Betrag: nicht lesbar, 0, negativ und über dem Höchstbetrag des Servers", () => {
    for (const betrag of ["12€50", "0", "-100", "100.000.000.000,01"]) expect(ausschuettungFehler({ ...gut, betrag }).betrag, betrag).not.toBeNull();
    expect(ausschuettungFehler({ ...gut, betrag: "100.000.000.000,00" }).betrag).toBeNull();
  });

  it("Geschäftsjahr: wie der Server von 1900 bis 2999", () => {
    for (const geschaeftsjahr of ["1899", "3000", "25", "2025,5", "abc"])
      expect(ausschuettungFehler({ ...gut, geschaeftsjahr }).geschaeftsjahr, geschaeftsjahr).not.toBeNull();
    for (const geschaeftsjahr of ["1900", "2999", " 2025 "]) expect(ausschuettungFehler({ ...gut, geschaeftsjahr }).geschaeftsjahr, geschaeftsjahr).toBeNull();
  });
});
