import { describe, expect, it } from "vitest";
import { DEFAULT_DESIGN, designWithDefaults } from "./letterhead-design.ts";
import { eingebautesLayout, layoutOptionen } from "./layout-katalog.ts";
import { customFooter, footerValues } from "./footer-template.ts";
import { legalAsColumn, legalFooterIssues, legalInFooter, legalStelle, missingLegalPlaceholders } from "./footer-legal.ts";

const seller = {
  name: "Nordlicht Design GmbH",
  strasse: "Speicherstraße 12",
  plz: "28217",
  ort: "Bremen",
  email: "hallo@nordlicht.example",
  steuernummer: "60/123/45678",
  legalInfo: { seat: "Bremen", registerCourt: "Amtsgericht Bremen", registerNumber: "HRB 34567 HB", managingDirectors: ["Erika Mustermann", "Jonas Beispiel"] },
};

const ALLE =
  "Sitz {sitz}\n{rechtsform}\n{registergericht} {registernummer}\nGeschäftsführung {geschaeftsfuehrung}\nVorsitz des Aufsichtsrats {aufsichtsratsvorsitz}";
const stelle = (id: string, optionen: Record<string, string> = {}, gewaehlt: "layout" | "spalte" | "zeile" = "layout") => {
  const layout = eingebautesLayout(id)!;
  return legalStelle(layout, layoutOptionen(layout, optionen), gewaehlt);
};

describe("Platzhalter der Pflichtangaben (#1651)", () => {
  it("setzt die Angaben nach § 35a GmbHG einzeln ein; ohne Aufsichtsrat und bei der Rechtsform im Namen fällt die Zeile weg", () => {
    expect(customFooter([ALLE, "Steuernummer {steuernummer}"], footerValues(seller))[0]).toEqual([
      "Sitz Bremen",
      "Amtsgericht Bremen HRB 34567 HB",
      "Geschäftsführung Erika Mustermann, Jonas Beispiel",
    ]);
  });

  it("nennt die Rechtsform, wenn der Name sie nicht zeigt", () => {
    expect(footerValues({ ...seller, legalInfo: { ...seller.legalInfo, legalForm: "GmbH" } }).rechtsform).toBe("GmbH");
  });

  it("bleibt beim Einzelunternehmen leer", () => {
    const { legalInfo: _ohne, ...einzel } = seller;
    expect(customFooter(["Sitz {sitz}\n{firma}", "{steuernummer}"], footerValues(einzel))[0]).toEqual(["Nordlicht Design GmbH"]);
  });

  it("erkennt, ob die Platzhalter in der Fußzeile stehen, und nennt die fehlenden", () => {
    expect(legalInFooter(["{firma}", "{steuernummer}"])).toBe(false);
    // Nur alle zählen: Eine Fußzeile aus der Zeit als Einzelunternehmen mit {sitz} allein ließe sonst den Rest weg
    expect(legalInFooter(["{firma}", "{sitz}"])).toBe(false);
    expect(legalInFooter(["{firma}", ALLE])).toBe(true);
    expect(missingLegalPlaceholders(["{sitz}\n{registernummer}"])).toEqual(["rechtsform", "registergericht", "geschaeftsfuehrung", "aufsichtsratsvorsitz"]);
    expect(missingLegalPlaceholders([ALLE])).toEqual([]);
  });
});

describe("Sperre beim Speichern", () => {
  const gmbh = { kapitalgesellschaft: true, legalAsColumn: true };

  it("GmbH: ein Teil der Platzhalter reicht nicht, die fehlenden sind genannt", () => {
    expect(legalFooterIssues(["Sitz {sitz}", "{steuernummer}"], gmbh)).toEqual([
      "Pflichtangaben nach § 35a GmbHG unvollständig, es fehlen {rechtsform}, {registergericht}, {registernummer}, {geschaeftsfuehrung} und {aufsichtsratsvorsitz}. Setze alle ein oder keinen, dann setzt Haben sie selbst.",
    ]);
  });

  it("GmbH: alle oder keiner ist in Ordnung", () => {
    expect(legalFooterIssues([ALLE, "{steuernummer}", "{iban}", "{email}"], gmbh)).toEqual([]);
    expect(legalFooterIssues(["{firma}", "{steuernummer}", "{iban}"], gmbh)).toEqual([]);
  });

  it("GmbH: Als Spalte zählen die Pflichtangaben zu höchstens 4 Spalten, als Zeile nicht", () => {
    const vier = ["{firma}", "{steuernummer}", "{iban}", "{email}"];
    expect(legalFooterIssues(vier, gmbh)).toEqual([
      "Die Pflichtangaben der Gesellschaft stehen als eigene Spalte daneben, mehr als 4 Spalten passen nicht: Kürze auf 3 Spalten oder setze die Platzhalter der Pflichtangaben ein.",
    ]);
    expect(legalFooterIssues(vier, { ...gmbh, legalAsColumn: false })).toEqual([]);
  });

  it("Einzelunternehmen: keine Sperre", () => {
    expect(legalFooterIssues(["{sitz}", "{steuernummer}", "{iban}", "{email}"], { kapitalgesellschaft: false, legalAsColumn: true })).toEqual([]);
  });
});

describe("Stelle der Pflichtangaben", () => {
  it("Wie im Layout: Klassisch als Zeile darunter, die anderen als Spalte, die Randspalten in der Randspalte", () => {
    expect(stelle("klar", { fassung: "klassisch" })).toBe("zeile");
    expect(stelle("klar")).toBe("spalte");
    expect(stelle("modern")).toBe("spalte");
    expect(stelle("elegant", { fuss: "unten" })).toBe("spalte");
    expect(stelle("elegant", { fuss: "rechts" })).toBe("rand");
    expect(stelle("atelier", { fuss: "rechts" })).toBe("rand");
  });

  it("die Wahl gilt außer in der Randspalte", () => {
    expect(stelle("klar", { fassung: "klassisch" }, "spalte")).toBe("spalte");
    expect(stelle("klar", {}, "zeile")).toBe("zeile");
    expect(stelle("elegant", { fuss: "rechts" }, "zeile")).toBe("rand");
  });

  it("Spalte, sobald ein eingebautes Layout einer Belegart sie als Spalte setzt", () => {
    expect(legalAsColumn(DEFAULT_DESIGN)).toBe(true);
    const klassisch = designWithDefaults({ layoutOptions: { klar: { fassung: "klassisch" } } });
    expect(legalAsColumn(klassisch)).toBe(false);
    expect(legalAsColumn({ ...klassisch, legalPosition: "spalte" })).toBe(true);
    expect(legalAsColumn({ ...DEFAULT_DESIGN, legalPosition: "zeile" })).toBe(false);
    const eigen = { ...klassisch, layouts: { ...klassisch.layouts, mahnung: { kind: "eigen" as const, id: "x" } } };
    expect(legalAsColumn(eigen)).toBe(false);
  });
});
