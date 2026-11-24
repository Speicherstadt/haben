import { amountError } from "@haben/core";
import { describe, expect, it } from "vitest";
import { auswerten, type MitarbeiterWerte, NEUER_MITARBEITER, type Texte, texte } from "./mitarbeiter-pruefung.ts";

const gut: MitarbeiterWerte = {
  ...NEUER_MITARBEITER,
  art: "beschaeftigt",
  vorname: "Lena",
  nachname: "Beispiel",
  geburtsdatum: "1990-05-12",
  eintritt: "2026-01-01",
  monatsgehalt: 300000,
};

const pruefen = (aenderung: Partial<MitarbeiterWerte> = {}, text: Partial<Texte> = {}) => {
  const w = { ...gut, ...aenderung };
  return auswerten(w, { ...texte(w), ...text });
};
const fehlerVon = (aenderung: Partial<MitarbeiterWerte>, text: Partial<Texte> = {}) =>
  Object.fromEntries(Object.entries(pruefen(aenderung, text).fehler).filter(([, f]) => f !== null));

// #1277: statt der ersten Beanstandung unter dem Formular je Feld eine Meldung, Grenzen wie `employeeSchema` des Servers
describe("Prüfung des Mitarbeiterformulars", () => {
  it("nimmt gültige Angaben an", () => {
    const { fehler, werte } = pruefen();
    expect(Object.values(fehler).every((f) => f === null)).toBe(true);
    expect(werte).toEqual(gut);
  });

  it("meldet jedes Pflichtfeld für sich", () => {
    expect(fehlerVon({ vorname: " ", nachname: "", geburtsdatum: "", eintritt: "", monatsgehalt: 0 })).toEqual({
      vorname: "Trag den Vornamen ein.",
      nachname: "Trag den Nachnamen ein.",
      geburtsdatum: "Wähle das Geburtsdatum.",
      eintritt: "Wähle den Tag des Eintritts.",
      monatsgehalt: amountError(),
    });
  });

  it("meldet einen ungültigen Betrag wie jedes Betragsfeld (#1242)", () => {
    expect(pruefen({}, { monatsgehalt: "viel" }).fehler.monatsgehalt).toBe("Trag den Betrag ein, etwa 1.234,56.");
    expect(pruefen({}, { monatsgehalt: "3.000 Euro" }).fehler.monatsgehalt).toBe("Trag den Betrag ein, etwa 1.234,56.");
    expect(pruefen({ krankenversicherung: "privat" }, { pkvZuschuss: "3€00" }).fehler.pkvZuschuss).toBe(
      "Trag den Betrag ein, etwa 1.234,56, oder lass das Feld leer.",
    );
  });

  it("Monatsgehalt über 0 bis 10.000.000,00 wie der Server", () => {
    const grenze = "Trag einen Betrag über 0 bis 10.000.000,00 ein, etwa 1.234,56.";
    for (const monatsgehalt of ["0", "-100", "10.000.000,01"]) expect(pruefen({}, { monatsgehalt }).fehler.monatsgehalt, monatsgehalt).toBe(grenze);
    expect(pruefen({}, { monatsgehalt: "10.000.000,00" }).werte.monatsgehalt).toBe(10_000_000_00);
    expect(pruefen({}, { monatsgehalt: "3.000 €" }).werte.monatsgehalt).toBe(300000);
  });

  it("Beiträge der privaten Versicherung dürfen leer bleiben, nicht negativ, bis 10.000.000,00", () => {
    const privat = { krankenversicherung: "privat" as const };
    expect(pruefen(privat, { pkvBasisbeitrag: "", pkvZuschuss: "" }).werte).toMatchObject({ pkvBasisbeitrag: 0, pkvZuschuss: 0 });
    expect(pruefen(privat, { pkvBasisbeitrag: "-5" }).fehler.pkvBasisbeitrag).toBe(
      "Trag einen Betrag von 0 bis 10.000.000,00 ein, etwa 1.234,56, oder lass das Feld leer.",
    );
    expect(pruefen(privat, { pkvZuschuss: "10.000.000,01" }).fehler.pkvZuschuss).not.toBeNull();
  });

  it("liest Zusatzbeitrag und Umlage wie jedes Prozentfeld, auch mit „%“ (#1222)", () => {
    const { werte } = pruefen({}, { zusatzbeitrag: "2,9 %", u2Satz: "0.24" });
    expect([werte.zusatzbeitrag, werte.u2Satz]).toEqual([290, 24]);
  });

  it("nennt bei einem ungültigen Satz die Grenze des Servers, nicht einen Betrag", () => {
    expect(pruefen({}, { zusatzbeitrag: "2,9 €" }).fehler.zusatzbeitrag).toBe("Trag einen Satz von 0 bis 100 Prozent ein, etwa 2,9.");
    expect(pruefen({}, { u2Satz: "100,01" }).fehler.u2Satz).toBe("Trag einen Satz von 0 bis 100 Prozent ein, etwa 0,44.");
    expect(pruefen({}, { u1Satz: "-1" }).fehler.u1Satz).toBe("Trag einen Satz von 0 bis 100 Prozent ein, etwa 1,6, oder lass das Feld leer.");
    expect(pruefen({}, { zusatzbeitrag: "100" }).werte.zusatzbeitrag).toBe(10_000);
    expect(pruefen({}, { u1Satz: "" }).werte.u1Satz).toBeNull();
  });

  it("prüft nur Felder, die zu sehen sind; ausgeblendete behalten ihren Wert", () => {
    // Privat versichert: kein Zusatzbeitrag; Minijob: keine Umlagesätze und keine Krankenkasse
    const privat = pruefen({ krankenversicherung: "privat", zusatzbeitrag: 250 }, { zusatzbeitrag: "viel" });
    expect([privat.fehler.zusatzbeitrag, privat.werte.zusatzbeitrag]).toEqual([null, 250]);
    const minijob = pruefen({ art: "minijob", u2Satz: 24, u1Satz: 0 }, { u2Satz: "x", u1Satz: "x" });
    expect([minijob.fehler.u2Satz, minijob.fehler.u1Satz, minijob.werte.u2Satz, minijob.werte.u1Satz]).toEqual([null, null, 24, 0]);
    expect(fehlerVon({ art: "minijob", krankenkasseBetriebsnummer: "12" })).toEqual({});
    // Gesellschafter-Geschäftsführer ohne SV-Pflicht: keine Meldedaten
    expect(fehlerVon({ art: "ggf", personengruppe: "1", svNummer: "x" })).toEqual({});
  });

  it("Faktor nur in Steuerklasse IV, über 0 bis 1", () => {
    const meldung = "Trag einen Faktor über 0 bis 1 ein, etwa 0,950.";
    for (const faktor of ["0", "1,001", "0,9505", "x"]) expect(pruefen({ steuerklasse: 4 }, { faktor }).fehler.faktor, faktor).toBe(meldung);
    expect(pruefen({ steuerklasse: 4 }, { faktor: "0,95" }).werte.faktor).toBe(950);
    // In einer anderen Steuerklasse ist das Feld ausgeblendet, der Server nimmt dann nur 1,000 an
    const klasse1 = pruefen({ steuerklasse: 1, faktor: 950 }, { faktor: "x" });
    expect([klasse1.fehler.faktor, klasse1.werte.faktor]).toEqual([null, 1000]);
  });

  it("Kinderfreibeträge von 0 bis 20 in Schritten von 0,5", () => {
    const meldung = "Trag eine Zahl von 0 bis 20 in Schritten von 0,5 ein, etwa 1,5.";
    for (const kinderfreibetraege of ["0,3", "20,5", "-1", "eins"])
      expect(pruefen({}, { kinderfreibetraege }).fehler.kinderfreibetraege, kinderfreibetraege).toBe(meldung);
    expect(pruefen({}, { kinderfreibetraege: "1,5" }).werte.kinderfreibetraege).toBe(1500);
    expect(pruefen({}, { kinderfreibetraege: "20" }).werte.kinderfreibetraege).toBe(20_000);
  });

  it("Kinder unter 25 als ganze Zahl bis 20, nicht zusammen mit dem Zuschlag für Kinderlose", () => {
    for (const kinderUnter25 of ["21", "2,5", "-1", "zwei"])
      expect(pruefen({}, { kinderUnter25 }).fehler.kinderUnter25, kinderUnter25).toBe("Trag eine ganze Zahl von 0 bis 20 ein.");
    expect(pruefen({}, { kinderUnter25: "" }).werte.kinderUnter25).toBe(0);
    expect(pruefen({}, { kinderUnter25: " 3 " }).werte.kinderUnter25).toBe(3);
    expect(pruefen({ kinderlosenzuschlag: true }, { kinderUnter25: "1" }).fehler.kinderlosenzuschlag).toBe(
      "Mit Kindern unter 25 fällt kein Zuschlag für Kinderlose an.",
    );
    expect(pruefen({ kinderlosenzuschlag: true }, { kinderUnter25: "0" }).fehler.kinderlosenzuschlag).toBeNull();
  });

  it("Austritt nicht vor dem Eintritt", () => {
    expect(pruefen({ austritt: "2025-12-31" }).fehler.austritt).toBe("Wähle einen Tag ab dem Eintritt.");
    expect(pruefen({ austritt: "2026-01-01" }).fehler.austritt).toBeNull();
    expect(pruefen({ austritt: "2025-12-31", eintritt: "" }).fehler.austritt).toBeNull();
  });

  it("Steuer-ID mit 11 Ziffern ohne führende 0 oder leer; die Prüfziffer prüft der Server", () => {
    const meldung = "Trag eine gültige Steuer-ID mit 11 Ziffern ein, oder lass das Feld leer.";
    for (const steuerId of ["12345", "01234567890", "860957427190", "8609574271x"]) expect(pruefen({ steuerId }).fehler.steuerId, steuerId).toBe(meldung);
    for (const steuerId of ["", " 86095742719 "]) expect(pruefen({ steuerId }).fehler.steuerId, steuerId).toBeNull();
  });

  it("IBAN mit Prüfziffer oder leer", () => {
    expect(pruefen({ iban: "DE89 3704 0044 0532 0130 01" }).fehler.iban).toBe("Trag eine gültige IBAN ein, oder lass das Feld leer.");
    for (const iban of ["", "DE89 3704 0044 0532 0130 00", "de89370400440532013000"]) expect(pruefen({ iban }).fehler.iban, iban).toBeNull();
  });

  it("Schlüssel und Nummern der Sozialversicherung in der Form des Servers oder leer", () => {
    expect(
      fehlerVon({
        krankenkasseBetriebsnummer: "1234567",
        personengruppe: "10",
        beitragsgruppen: "11111",
        taetigkeitsschluessel: "51222000",
        svNummer: "65150301123",
      }),
    ).toEqual({
      krankenkasseBetriebsnummer: "Trag die Betriebsnummer mit 8 Ziffern ein, oder lass das Feld leer.",
      personengruppe: "Trag den Schlüssel mit 3 Ziffern ein, etwa 101, oder lass das Feld leer.",
      beitragsgruppen: "Trag den Schlüssel mit 4 Ziffern ein, etwa 1111, oder lass das Feld leer.",
      taetigkeitsschluessel: "Trag den Schlüssel mit 9 Ziffern ein, oder lass das Feld leer.",
      svNummer: "Trag die Versicherungsnummer mit 12 Stellen ein (8 Ziffern, Buchstabe, 3 Ziffern), oder lass das Feld leer.",
    });
    expect(
      fehlerVon({
        krankenkasseBetriebsnummer: "12345678",
        personengruppe: "101",
        beitragsgruppen: "1111",
        taetigkeitsschluessel: "512220000",
        svNummer: "65150301a123",
      }),
    ).toEqual({});
    expect(pruefen({ art: "minijob" }).fehler.personengruppe).toBeNull();
    expect(pruefen({ art: "minijob", personengruppe: "1" }).fehler.personengruppe).toBe(
      "Trag den Schlüssel mit 3 Ziffern ein, etwa 109, oder lass das Feld leer.",
    );
  });
});
