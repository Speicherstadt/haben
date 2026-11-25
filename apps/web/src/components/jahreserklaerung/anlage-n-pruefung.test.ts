import { describe, expect, it } from "vitest";
import { toArbeitnehmerDraft } from "../AnlageN.tsx";
import { anlageNLesen, anSchluessel } from "./anlage-n-pruefung.ts";
import type { Fehler } from "./eingabe-pruefung.ts";

// #1277: statt „Kein gültiger Betrag: …“ über der Knopfzeile je Person, Bescheinigung und Feld eine Meldung am Feld
const leer = toArbeitnehmerDraft(undefined);
const bescheinigung = (key: number, werte: Record<string, string> = {}) => ({ ...leer.bescheinigungen[0]!, key, brutto: "42.000,00", ...werte });
const entwurf = (werte: Partial<typeof leer> = {}) => ({ ...leer, aktiv: true, bescheinigungen: [bescheinigung(1)], ...werte });
const lesen = (d: typeof leer, p: "a" | "b" = "a") => {
  const fehler: Fehler = {};
  return { an: anlageNLesen(d, p, fehler), fehler };
};
const gemeldet = (fehler: Fehler) => Object.fromEntries(Object.entries(fehler).filter(([, meldung]) => meldung !== null));

describe("Anlage N: Prüfung je Feld", () => {
  it("ohne Arbeitslohn: nichts zu lesen, keine Meldung", () => {
    expect(lesen({ ...entwurf({ tage: "x" }), aktiv: false })).toEqual({ an: undefined, fehler: {} });
  });

  it("nimmt gültige Angaben an und meldet jedes Feld mit null", () => {
    const { an, fehler } = lesen(entwurf({ adresse: " 77815 Bühl ", tage: "200", km: "12,5", homeofficeTage: "20", arbeitsmittel: "350,00" }));
    expect(gemeldet(fehler)).toEqual({});
    expect(fehler[anSchluessel("a", "brutto", 1)]).toBeNull();
    expect(fehler[anSchluessel("a", "tage")]).toBeNull();
    expect(an?.bescheinigungen).toEqual([{ steuerklasse: 1, brutto: 4_200_000 }]);
    expect(an?.werbungskosten).toMatchObject({ wege: { tage: 200, km: 12.5, adresse: "77815 Bühl" }, homeofficeTage: 20, arbeitsmittel: 35_000 });
  });

  it("Bescheinigungen: Meldung je Person, Bescheinigung und Feld", () => {
    const d = entwurf({ bescheinigungen: [bescheinigung(7, { lohnsteuer: "12€50" }), bescheinigung(8, { brutto: "" })] });
    expect(gemeldet(lesen(d).fehler)).toEqual({
      "an-a-7-lohnsteuer": "Trag den Betrag ein, etwa 1.234,56, oder lass das Feld leer.",
      "an-a-8-brutto": "Trag den Bruttoarbeitslohn ein, etwa 42.000,00.",
    });
    expect(Object.keys(gemeldet(lesen(d, "b").fehler))).toEqual(["an-b-7-lohnsteuer", "an-b-8-brutto"]);
  });

  it("Bruttoarbeitslohn: Pflicht, über 0 und höchstens wie der Server", () => {
    const meldung = (brutto: string) => lesen(entwurf({ bescheinigungen: [bescheinigung(1, { brutto })] })).fehler["an-a-1-brutto"];
    for (const brutto of ["", "0", "-5", "viel"]) expect(meldung(brutto), brutto).toBe("Trag den Bruttoarbeitslohn ein, etwa 42.000,00.");
    expect(meldung("100.000.000,01")).toBe("Trag einen Bruttoarbeitslohn bis 100.000.000,00 ein, etwa 42.000,00.");
    expect(meldung("100.000.000,00")).toBeNull();
  });

  it("Beträge der Werbungskosten: nicht negativ und höchstens 100.000.000,00 wie der Server", () => {
    const grenze = "Trag einen Betrag von 0 bis 100.000.000,00 ein, etwa 1.234,56, oder lass das Feld leer.";
    expect(lesen(entwurf({ fortbildung: "-1" })).fehler["an-a-fortbildung"]).toBe(grenze);
    expect(lesen(entwurf({ sonstige: "100.000.000,01" })).fehler["an-a-sonstige"]).toBe(grenze);
  });

  it("Wege zur Arbeit: Tage, Entfernung und Anschrift melden sich einzeln", () => {
    const tage = "Trag die Tage an der Tätigkeitsstätte als ganze Zahl von 1 bis 366 ein.";
    const km = "Trag die einfache Entfernung von 1 bis 9.999 km ein, etwa 12,5.";
    const adresse = "Trag die Anschrift der ersten Tätigkeitsstätte ein.";
    expect(gemeldet(lesen(entwurf({ km: "25" })).fehler)).toEqual({ "an-a-tage": tage, "an-a-adresse": adresse });
    // Eine Anschrift allein fiel bisher still weg
    expect(gemeldet(lesen(entwurf({ adresse: "Bühl" })).fehler)).toEqual({ "an-a-tage": tage, "an-a-km": km });
    expect(gemeldet(lesen(entwurf({ urlaubstage: "30" })).fehler)).toEqual({ "an-a-tage": tage, "an-a-km": km, "an-a-adresse": adresse });
    // Grenzen des Servers: Tage ganz von 1 bis 366, Entfernung von 1 bis 9.999
    const mit = (werte: Partial<typeof leer>) => gemeldet(lesen(entwurf({ adresse: "Bühl", tage: "200", km: "25", ...werte })).fehler);
    for (const t of ["0", "367", "3,5", "abc"]) expect(mit({ tage: t }), t).toEqual({ "an-a-tage": tage });
    for (const k of ["0,5", "10000", "-3"]) expect(mit({ km: k }), k).toEqual({ "an-a-km": km });
    expect(mit({ arbeitstageJeWoche: "8" })).toEqual({
      "an-a-arbeitstageJeWoche": "Trag die Arbeitstage je Woche als ganze Zahl von 1 bis 7 ein, oder lass das Feld leer.",
    });
    expect(mit({ urlaubstage: "367" })).toEqual({
      "an-a-urlaubstage": "Trag die Urlaubs- und Krankheitstage als ganze Zahl bis 366 ein, oder lass das Feld leer.",
    });
    expect(lesen(entwurf({ adresse: "Bühl", tage: "200", km: "25", arbeitstageJeWoche: "5", urlaubstage: "30" })).an?.werbungskosten.wege).toEqual({
      tage: 200,
      km: 25,
      adresse: "Bühl",
      arbeitstageJeWoche: 5,
      urlaubstage: 30,
    });
  });

  it("Homeoffice-Tage und Monate als Mittelpunkt: ganze Zahlen in den Grenzen des Servers", () => {
    for (const homeofficeTage of ["3,5", "367"])
      expect(gemeldet(lesen(entwurf({ homeofficeTage })).fehler), homeofficeTage).toEqual({
        "an-a-homeofficeTage": "Trag die Homeoffice-Tage als ganze Zahl bis 366 ein, oder lass das Feld leer.",
      });
    for (const arbeitszimmerMonate of ["13", "1,5"])
      expect(gemeldet(lesen(entwurf({ arbeitszimmerMonate })).fehler), arbeitszimmerMonate).toEqual({
        "an-a-arbeitszimmerMonate": "Trag die Monate als ganze Zahl von 0 bis 12 ein, oder lass das Feld leer.",
      });
  });
});
