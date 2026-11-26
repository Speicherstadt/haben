import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentSplits, anteilBeimAufheben, privatanteilInZeilen, splitRow } from "./DocumentSplits.tsx";
import { privatanteilHinweis } from "./VorsteuerAnteil.tsx";

/*
 * Privatanteil je Zeile (#1914): Beim Aufheben der Aufteilung übernimmt der Beleg den Anteil der ersten Zeile, eine
 * ungültige Eingabe zählt nicht als Zeilenanteil, und der Hinweis am Feld nennt die Vorsteuer nur, wenn es einen Abzug
 * gibt. Alle Daten sind erfunden.
 */

const beleg = (kleinunternehmer: boolean) => ({
  value: "",
  company: { kleinunternehmer, ohneVorsteuerabzug: false },
  booked: false,
  storedDeduction: true,
});

const render = (anteilHinweis: string) =>
  renderToStaticMarkup(
    createElement(DocumentSplits, {
      rows: [splitRow("telefon", 1900, "60,00", "", "25"), splitRow("internet", 1900, "40,00", "", "0")],
      amounts: [{ taxRate: 1900, net: 10_000, tax: 1900 }],
      categories: [{ value: "telefon", label: "Telefon" }],
      disabled: false,
      onChange: () => undefined,
      onDissolve: () => undefined,
      privatanteil: true,
      anteilHinweis,
    }),
  );

describe("Privatanteil je Zeile", () => {
  it("gibt beim Aufheben den Anteil der ersten Zeile an den Beleg zurück", () => {
    expect(anteilBeimAufheben([splitRow("telefon", 1900, "60,00", "", "20"), splitRow("internet", 1900, "40,00", "", "40")])).toBe("20");
  });

  it("lässt den Beleg ohne Zeilen betrieblich", () => {
    expect(anteilBeimAufheben([])).toBe("");
  });

  it("zählt nur einen lesbaren Anteil über 0 als Zeilenanteil", () => {
    expect(privatanteilInZeilen([splitRow("telefon", 1900, "60,00", "", "25")])).toBe(true);
    expect(privatanteilInZeilen([splitRow("telefon", 1900, "60,00", "", "0"), splitRow("internet", 1900, "40,00")])).toBe(false);
    // Eine ungültige Eingabe ist kein gültiger Zeilenanteil; sonst bliebe der Hinweis auf die gültige Eingabe aus
    expect(privatanteilInZeilen([splitRow("telefon", 1900, "60,00", "", "abc")])).toBe(false);
    expect(privatanteilInZeilen([splitRow("telefon", 1900, "60,00", "", "101")])).toBe(false);
    expect(privatanteilInZeilen([])).toBe(false);
  });

  it("nennt im Hinweis ohne Vorsteuerabzug nur die Ausgabe", () => {
    const ohneAbzug = render(privatanteilHinweis(beleg(true), [{ vorsteuerAnteil: "" }]));
    expect(ohneAbzug).toContain("nur der betriebliche Teil wird Ausgabe.");
    expect(ohneAbzug).not.toContain("Ausgabe und Vorsteuer");
  });

  it("nennt im Hinweis mit Vorsteuerabzug Ausgabe und Vorsteuer", () => {
    expect(render(privatanteilHinweis(beleg(false), [{ vorsteuerAnteil: "" }]))).toContain("nur der betriebliche Teil wird Ausgabe und Vorsteuer.");
  });
});
