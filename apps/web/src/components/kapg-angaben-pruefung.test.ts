import { amountError } from "@haben/core";
import { describe, expect, it } from "vitest";
import type { Person } from "./KapgAnteilseigner.tsx";
import { type AngabenFormular, kapgAngabenFehler } from "./kapg-angaben-pruefung.ts";

// #1277: statt eines Satzes für alle Felder je Feld und Zeile eine Meldung, mit den Grenzen von kapgErklaerungSchema
describe("Prüfung der Angaben zu den Erklärungen der GmbH", () => {
  const person: Person = {
    name: "Erika Muster",
    strasse: "Hafenallee 3",
    plzOrt: "28217 Bremen",
    nummer: "86095742719",
    beteiligung: "25.000,00",
    anteil: "100",
    geaendert: false,
    kirchensteuer: 0,
    religionsschluessel: "",
    religionsgemeinschaft: "",
  };
  const vertrag = { art: "Geschäftsführervertrag", datum: "2025-01-01", partner: "Erika Muster", verguetung: "60.000,00" };
  const gut: AngabenFormular = { year: 2025, gruendung: "", einlagekonto: "", rechte: "", personen: [person], vertraege: [vertrag] };
  const fehler = (f: Partial<AngabenFormular>) => Object.fromEntries(Object.entries(kapgAngabenFehler({ ...gut, ...f })).filter(([, e]) => e !== null));
  const bereich = "Trag einen Betrag von 0,00 bis 100.000.000.000,00 ein";

  it("nimmt gültige Angaben an, leere Beträge oben gelten als 0", () => {
    expect(fehler({})).toEqual({});
    expect(fehler({ einlagekonto: "-1.500,00", rechte: "0", gruendung: "2025-03-01" })).toEqual({});
  });

  it("nennt je Feld und Zeile einen eigenen Schlüssel, auch für fehlerfreie Felder", () => {
    expect(Object.keys(kapgAngabenFehler({ ...gut, personen: [person, person] }))).toEqual(
      expect.arrayContaining(["gruendung", "einlagekonto", "rechte", "anteilseigner.1.anteil", "anteilseigner.0.name", "vertrag.0.verguetung"]),
    );
  });

  it("Pflichtfelder eines Anteilseigners, die vorher der Browser meldete; nur Leerzeichen gilt als leer", () => {
    const leer = { ...person, name: " ", strasse: "", plzOrt: "", nummer: "", beteiligung: "", anteil: "" };
    expect(fehler({ personen: [person, leer] })).toEqual({
      "anteilseigner.1.name": "Trag den Namen ein.",
      "anteilseigner.1.strasse": "Trag Straße und Hausnummer ein.",
      "anteilseigner.1.plzOrt": "Trag PLZ und Ort ein.",
      "anteilseigner.1.nummer": "Trag die Identifikationsnummer mit 11 Ziffern oder die Steuernummer mit 13 Ziffern ein.",
      "anteilseigner.1.beteiligung": amountError("die Beteiligung", 2_500_000),
      "anteilseigner.1.anteil": "Trag den Anteil in Prozent ein, etwa 50 oder 33,33.",
    });
  });

  it("Anteil: über 0 bis 100 % mit höchstens zwei Nachkommastellen", () => {
    for (const anteil of ["33,333", "0", "100,01", "-5", "abc"])
      expect(fehler({ personen: [{ ...person, anteil }] }), anteil).toHaveProperty(["anteilseigner.0.anteil"]);
    for (const anteil of ["0,01", "33,33", "100", "50 %"]) expect(fehler({ personen: [{ ...person, anteil }] }), anteil).toEqual({});
  });

  it("Nummer: 11 Ziffern als Identifikationsnummer oder 13 als Steuernummer, Trennzeichen zählen nicht", () => {
    for (const nummer of ["8609574271", "860957427190", "12345678901234"])
      expect(fehler({ personen: [{ ...person, nummer }] }), nummer).toHaveProperty(["anteilseigner.0.nummer"]);
    for (const nummer of ["86 095 742 719", "2181/508/150678", "2181508150678"]) expect(fehler({ personen: [{ ...person, nummer }] }), nummer).toEqual({});
  });

  it("Religionsschlüssel mit sechs Ziffern nur bei Kirchensteuer", () => {
    const mit = { ...person, kirchensteuer: 9 as const };
    expect(fehler({ personen: [{ ...mit, religionsschluessel: "" }] })).toEqual({
      "anteilseigner.0.religionsschluessel": "Trag den Religionsschlüssel mit sechs Ziffern ein, etwa 010100.",
    });
    expect(fehler({ personen: [{ ...mit, religionsschluessel: "01010" }] })).toHaveProperty(["anteilseigner.0.religionsschluessel"]);
    expect(fehler({ personen: [{ ...mit, religionsschluessel: " 010100 " }] })).toEqual({});
    expect(fehler({ personen: [{ ...person, religionsschluessel: "x" }] })).toEqual({});
  });

  it("Beträge mit der Meldung aus amountError und den Grenzen des Servers", () => {
    expect(fehler({ einlagekonto: "12€50", rechte: "-1,00" })).toEqual({
      einlagekonto: amountError("den Betrag", 2_500_000, { optional: true }),
      rechte: `${bereich}, etwa 1.000,00, oder lass das Feld leer.`,
    });
    expect(fehler({ einlagekonto: "100.000.000.000,01" })).toEqual({
      einlagekonto: "Trag einen Betrag von -100.000.000.000,00 bis 100.000.000.000,00 ein, etwa 25.000,00, oder lass das Feld leer.",
    });
    expect(fehler({ einlagekonto: "-100.000.000.000,00", rechte: "100.000.000.000,00" })).toEqual({});
    expect(fehler({ personen: [{ ...person, beteiligung: "-1" }] })).toEqual({ "anteilseigner.0.beteiligung": `${bereich}, etwa 25.000,00.` });
    expect(fehler({ personen: [{ ...person, beteiligung: "0" }] })).toEqual({});
  });

  it("Vertrag: Art, Datum, Partner und Vergütung je Zeile", () => {
    const leer = { art: "", datum: "", partner: " ", verguetung: "" };
    expect(fehler({ vertraege: [vertrag, leer] })).toEqual({
      "vertrag.1.art": "Trag die Vertragsart ein, etwa Geschäftsführervertrag.",
      "vertrag.1.datum": "Wähle das Datum.",
      "vertrag.1.partner": "Trag den Vertragspartner ein.",
      "vertrag.1.verguetung": amountError("die Vergütung", 6_000_000),
    });
    expect(fehler({ vertraege: [{ ...vertrag, verguetung: "100.000.000.000,01" }] })).toEqual({ "vertrag.0.verguetung": `${bereich}, etwa 60.000,00.` });
  });

  it("Gründung nur im Jahr der Erklärung, wie saveKapgErklaerungAngaben", () => {
    expect(fehler({ gruendung: "2024-12-31" })).toEqual({ gruendung: "Wähle einen Tag vom 01.01.2025 bis 31.12.2025." });
    expect(fehler({ gruendung: "2025-12-31" })).toEqual({});
  });
});
