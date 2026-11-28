import { describe, expect, it } from "vitest";
import { DIREKT_AUSGABE_KATEGORIEN } from "./direkt-kategorie.ts";
import {
  BELEGKATEGORIEN,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_KEYS,
  hatEigenschaft,
  kategorienMit,
  PRIVATENTNAHME,
  type ExpenseCategory,
} from "./kontenplan.ts";
import { ownAccountParents } from "./own-accounts.ts";

/*
 * Der Steckbrief je Kategorie (#1975) ersetzt Listen, die an mehreren Stellen standen. Die Listen hier sind der Stand vor
 * der Umstellung: Solange sie gelten, ändert der Steckbrief am Verhalten nichts. Eine neue Kategorie beantwortet ihre Fragen
 * im Steckbrief; ändert sich eine Antwort bewusst, ändert sich auch die Liste hier.
 */
const ohne = (...ausgenommen: ExpenseCategory[]) => EXPENSE_CATEGORY_KEYS.filter((k) => !ausgenommen.includes(k));

describe("Steckbrief der Ausgabenkategorien", () => {
  it("zählt Anlagegut und Einfuhrumsatzsteuer nicht als Aufwand (bisher journal-euer.ts und sevdesk/kategorie.ts)", () => {
    expect(kategorienMit("aufwand")).toEqual(ohne("anlage", "einfuhrumsatzsteuer", "privatentnahme"));
  });

  it("lässt unter „Direkt buchen“ dieselben Kategorien zu wie bisher (NUR_MIT_BELEG und SCHON_DIREKT)", () => {
    const bisher = ohne("anlage", "hardware", "einfuhrumsatzsteuer", "bewirtung", "geschenke", "geldverkehr", "privatentnahme");
    expect(kategorienMit("direkt")).toEqual(bisher);
    expect(DIREKT_AUSGABE_KATEGORIEN).toEqual(bisher);
  });

  it("lässt dieselben Elternkategorien für eigene Konten zu wie bisher (EXCLUDED_PARENTS)", () => {
    const bisher = ohne("anlage", "hardware", "einfuhrumsatzsteuer", "geldverkehr", "wareneinkauf", "fremdleistung", "kfzSteuer", "privatentnahme");
    expect(kategorienMit("eigenesKonto")).toEqual(bisher);
    for (const kontenrahmen of ["SKR03", "SKR04"] as const) {
      expect(ownAccountParents(kontenrahmen).every((k) => bisher.includes(k))).toBe(true);
    }
  });

  it("bietet für Dauerbelege alle Kategorien außer dem Anlagegut an wie bisher", () => {
    expect(kategorienMit("dauerbeleg")).toEqual(ohne("anlage", "privatentnahme"));
  });

  it("kennt für eine unbekannte Kategorie keine Eigenschaft", () => {
    expect(hatEigenschaft("gibtEsNicht", "aufwand")).toBe(false);
    expect(hatEigenschaft("telefon", "aufwand")).toBe(true);
  });

  it("führt die Privatentnahme mit 1800 in SKR03 und 2100 in SKR04, aber ohne die vier Eigenschaften (#1975)", () => {
    expect(PRIVATENTNAHME).toBe("privatentnahme");
    expect(EXPENSE_CATEGORIES.privatentnahme).toEqual({
      label: "Privatentnahme",
      SKR03: "1800",
      SKR04: "2100",
      nicht: ["aufwand", "direkt", "eigenesKonto", "dauerbeleg"],
    });
    for (const eigenschaft of ["aufwand", "direkt", "eigenesKonto", "dauerbeleg"] as const) {
      expect(hatEigenschaft(PRIVATENTNAHME, eigenschaft)).toBe(false);
      expect(kategorienMit(eigenschaft)).not.toContain(PRIVATENTNAHME);
    }
  });

  it("lässt die Privatentnahme nicht als Kategorie eines Belegs zu (#1975)", () => {
    expect(BELEGKATEGORIEN).toEqual(EXPENSE_CATEGORY_KEYS.filter((k) => k !== PRIVATENTNAHME));
    expect(BELEGKATEGORIEN).not.toContain(PRIVATENTNAHME);
    expect(BELEGKATEGORIEN).toContain("anlage");
  });
});
