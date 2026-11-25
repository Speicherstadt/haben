import { describe, expect, it } from "vitest";
import { toArbeitnehmerDraft } from "../AnlageN.tsx";
import { estAngabenLesen, type KindDraft } from "./est-pruefung.ts";

// #1277: „Angaben speichern“ meldet jeden Fehler an seinem Feld, mit einem Schlüssel je Feld und je Kind
const formular = (werte: Record<string, string> = {}) => ({ get: (name: string) => werte[name] ?? null });
const ohneArbeit = toArbeitnehmerDraft(undefined);
const entwurf = (kinder: KindDraft[] = []) => ({ kinder, anA: ohneArbeit, anB: ohneArbeit });
const kind = (key: number, werte: Partial<KindDraft> = {}): KindDraft => ({
  key,
  vorname: "Lena",
  geburtsdatum: "2016-04-12",
  familienkasse: "Familienkasse Baden-Württemberg West",
  kinderbetreuung: "",
  ...werte,
});
const gemeldet = (fehler: Record<string, string | null>) => Object.fromEntries(Object.entries(fehler).filter(([, meldung]) => meldung !== null));
const UNLESBAR = "Trag den Betrag ein, etwa 1.234,56, oder lass das Feld leer.";
const GRENZE = "Trag einen Betrag von 0 bis 100.000.000,00 ein, etwa 1.234,56, oder lass das Feld leer.";

/** Jedes Betragsfeld der Maske mit seinem Namen; die mit „b-“ und „erst-b-“ gibt es nur bei Zusammenveranlagung */
const BETRAGSFELDER = [
  ...["rv", "gkv", "gpv", "gkvZusatz", "pkv", "ppv", "pkvErstattung", "basisrente", "pkvWahlleistungen", "agZuschussGkv", "agZuschussKv", "agZuschussPv"].map(
    (f) => `a-${f}`,
  ),
  "sonstige",
  "kistGezahlt",
  "kistErstattet",
  "spenden",
  "krankheitskosten",
  "minijobs",
  "dienstleistungen",
  "handwerker",
  "kapMit",
  "kapSpb",
  "kapOhneInl",
  "kapAusl",
  "kapESt",
  "kapSoli",
  "kapKiSt",
  ...["Arbeitslosengeld", "Elterngeld", "Insolvenzgeld", "Krankengeld", "Mutterschaftsgeld", "Verdienstausfallentschädigung"].map((art) => `erst-a-${art}`),
];

describe("Angaben zur Einkommensteuer: Prüfung je Feld", () => {
  it("liest gültige Angaben und meldet jedes Feld mit null", () => {
    const { angaben, fehler } = estAngabenLesen(
      formular({ spenden: "12,50", "a-rv": "1.000", "erst-a-Elterngeld": "900", kapMit: "350,00", guenstigerpruefung: "on", handwerker: "0" }),
      false,
      entwurf([kind(3, { kinderbetreuung: "1.500,00", idnr: " 860 957 427 19 " })]),
    );
    expect(gemeldet(fehler)).toEqual({});
    for (const name of BETRAGSFELDER) expect(fehler[name], name).toBeNull();
    expect(angaben.sonderausgaben.spenden).toBe(1250);
    expect(angaben.vorsorge.a.rentenversicherung).toBe(100_000);
    expect(angaben.haushaltsnah.handwerker).toBeUndefined();
    expect(angaben.ersatzleistungen).toEqual({ a: [{ art: "Elterngeld", betrag: 90_000 }] });
    expect(angaben.kap).toMatchObject({ guenstigerpruefung: true, ertraegeMitSteuerabzug: 35_000 });
    expect(angaben.kinder).toEqual([
      {
        idnr: "860 957 427 19",
        vorname: "Lena",
        name: undefined,
        geburtsdatum: "2016-04-12",
        familienkasse: "Familienkasse Baden-Württemberg West",
        kinderbetreuung: 150_000,
      },
    ]);
  });

  it("meldet einen nicht lesbaren Betrag an genau seinem Feld", () => {
    for (const name of BETRAGSFELDER)
      expect(gemeldet(estAngabenLesen(formular({ [name]: "12€50" }), false, entwurf()).fehler), name).toEqual({ [name]: UNLESBAR });
  });

  it("Beträge wie der Server: nicht negativ, höchstens 100.000.000,00", () => {
    expect(gemeldet(estAngabenLesen(formular({ spenden: "-5", kapMit: "100.000.000,01" }), false, entwurf()).fehler)).toEqual({
      spenden: GRENZE,
      kapMit: GRENZE,
    });
    expect(gemeldet(estAngabenLesen(formular({ spenden: "100.000.000,00" }), false, entwurf()).fehler)).toEqual({});
  });

  it("Felder des Ehegatten nur bei Zusammenveranlagung", () => {
    const werte = { "b-rv": "x", "erst-b-Elterngeld": "x" };
    expect(gemeldet(estAngabenLesen(formular(werte), false, entwurf()).fehler)).toEqual({});
    expect(gemeldet(estAngabenLesen(formular(werte), true, entwurf()).fehler)).toEqual({ "b-rv": UNLESBAR, "erst-b-Elterngeld": UNLESBAR });
  });

  it("Kinder: Meldung je Kind und Feld, auch für Pflichtangaben und die Steuer-ID", () => {
    const fehler = estAngabenLesen(
      formular(),
      false,
      entwurf([kind(4), kind(9, { vorname: " ", geburtsdatum: "", familienkasse: "", idnr: "86095742718", kinderbetreuung: "viel" })]),
    ).fehler;
    expect(gemeldet(fehler)).toEqual({
      "kind-9-vorname": "Trag den Vornamen des Kindes ein.",
      "kind-9-geburtsdatum": "Wähle das Geburtsdatum.",
      "kind-9-idnr": "Trag eine gültige Steuer-ID mit 11 Ziffern ein, oder lass das Feld leer.",
      "kind-9-familienkasse": "Trag die zuständige Familienkasse ein.",
      "kind-9-kinderbetreuung": UNLESBAR,
    });
    expect(fehler["kind-4-vorname"]).toBeNull();
    expect(fehler["kind-4-kinderbetreuung"]).toBeNull();
  });

  it("nimmt die Meldungen der Anlage N je Person auf", () => {
    const an = { ...ohneArbeit, aktiv: true, bescheinigungen: ohneArbeit.bescheinigungen.map((b) => ({ ...b, brutto: "" })) };
    const key = an.bescheinigungen[0]!.key;
    const { fehler } = estAngabenLesen(formular(), true, { kinder: [], anA: ohneArbeit, anB: an });
    expect(gemeldet(fehler)).toEqual({ [`an-b-${key}-brutto`]: "Trag den Bruttoarbeitslohn ein, etwa 42.000,00." });
  });
});
