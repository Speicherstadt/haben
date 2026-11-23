import { amountError } from "@haben/core";
import { describe, expect, it } from "vitest";
import { ausschuettungFehler } from "./-ausschuettung-pruefung.ts";

// #1277: statt „Datum des Beschlusses, Geschäftsjahr und Betrag eingeben.“ je Feld eine Meldung
describe("Prüfung einer neuen Ausschüttung", () => {
  const gut = { beschluss: "2026-03-15", auszahlungstag: "", geschaeftsjahr: "2025", betrag: "30.000,00" };

  it("nimmt gültige Angaben an", () => {
    expect(ausschuettungFehler(gut)).toEqual({ beschluss: null, auszahlungstag: null, geschaeftsjahr: null, betrag: null });
  });

  it("meldet jedes Feld für sich", () => {
    expect(ausschuettungFehler({ beschluss: "", auszahlungstag: "", geschaeftsjahr: "", betrag: "" })).toEqual({
      beschluss: "Wähle das Datum des Beschlusses.",
      auszahlungstag: null,
      geschaeftsjahr: "Trag das Geschäftsjahr vierstellig ein, etwa 2025.",
      betrag: amountError("einen Betrag über 0", 3_000_000),
    });
  });

  // Der Server nimmt beides an, sperrt dann aber „Beschluss buchen“ mit einem Hinweis (ausschuettungVorschlag); der Grund liegt im Formular
  it("Auszahlungstag nicht vor dem Beschluss", () => {
    expect(ausschuettungFehler({ ...gut, auszahlungstag: "2026-03-14" }).auszahlungstag).toBe("Wähle einen Tag ab dem Beschluss.");
    for (const auszahlungstag of ["", "2026-03-15", "2026-04-01"])
      expect(ausschuettungFehler({ ...gut, auszahlungstag }).auszahlungstag, auszahlungstag).toBeNull();
  });

  it("Geschäftsjahr nicht nach dem Jahr des Beschlusses", () => {
    expect(ausschuettungFehler({ ...gut, geschaeftsjahr: "2027" }).geschaeftsjahr).toBe("Trag ein Geschäftsjahr bis 2026 ein, etwa 2025.");
    expect(ausschuettungFehler({ ...gut, geschaeftsjahr: "2026" }).geschaeftsjahr).toBeNull();
    expect(ausschuettungFehler({ ...gut, beschluss: "", geschaeftsjahr: "2027" }).geschaeftsjahr).toBeNull();
  });

  it("Betrag: nicht lesbar, 0, negativ und über dem Höchstbetrag des Servers", () => {
    for (const betrag of ["12€50", "0", "-100", "100.000.000.000,01"]) expect(ausschuettungFehler({ ...gut, betrag }).betrag, betrag).not.toBeNull();
    expect(ausschuettungFehler({ ...gut, betrag: "100.000.000.000,00" }).betrag).toBeNull();
  });

  it("Geschäftsjahr: wie der Server von 1900 bis 2999", () => {
    // Beschluss 2999, damit nur die Grenzen des Schemas zählen, nicht das Jahr des Beschlusses
    const spaet = { ...gut, beschluss: "2999-06-30" };
    for (const geschaeftsjahr of ["1899", "3000", "25", "2025,5", "abc"])
      expect(ausschuettungFehler({ ...spaet, geschaeftsjahr }).geschaeftsjahr, geschaeftsjahr).not.toBeNull();
    for (const geschaeftsjahr of ["1900", "2999", " 2025 "])
      expect(ausschuettungFehler({ ...spaet, geschaeftsjahr }).geschaeftsjahr, geschaeftsjahr).toBeNull();
  });
});
