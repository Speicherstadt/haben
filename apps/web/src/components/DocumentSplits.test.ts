import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DocumentSplits,
  anteilBeimAufheben,
  parseSplitRows,
  privatanteilFehler,
  privatanteilInZeilen,
  type SplitRowState,
  splitRow,
  wechslePrivatmodus,
} from "./DocumentSplits.tsx";
import { VorsteuerAnteil, privatanteilHinweis } from "./VorsteuerAnteil.tsx";

/*
 * Privatanteil je Zeile (#1914): Beim Aufheben der Aufteilung übernimmt der Beleg den Anteil der ersten Zeile, eine
 * ungültige Eingabe zählt nicht als Zeilenanteil, und der Hinweis am Feld nennt die Vorsteuer nur, wenn es einen Abzug
 * gibt. Seit #1926 trägt eine Zeile den Anteil auch als Betrag, wahlweise netto oder brutto; Prozent und Betrag
 * schließen sich aus. Alle Daten sind erfunden.
 */

const beleg = (kleinunternehmer: boolean) => ({
  value: "",
  company: { kleinunternehmer, ohneVorsteuerabzug: false },
  booked: false,
  storedDeduction: true,
});

const renderZeilen = (rows: SplitRowState[], anteilHinweis: string) =>
  renderToStaticMarkup(
    createElement(DocumentSplits, {
      rows,
      amounts: [{ taxRate: 1900, net: 10_000, tax: 1900 }],
      categories: [{ value: "telefon", label: "Telefon" }],
      disabled: false,
      onChange: () => undefined,
      onDissolve: () => undefined,
      privatanteil: true,
      anteilHinweis,
    }),
  );

const render = (anteilHinweis: string) =>
  renderZeilen([splitRow("telefon", 1900, "60,00", "", "25"), splitRow("internet", 1900, "40,00", "", "0")], anteilHinweis);

const vorschau = (privateShareJeZeile: boolean) =>
  renderToStaticMarkup(
    createElement(VorsteuerAnteil, {
      value: "",
      rows: [{ key: 1, taxRate: 1900, vorsteuerAnteil: "", net: 1000, tax: 190 }],
      company: { kleinunternehmer: false, ohneVorsteuerabzug: false },
      booked: false,
      storedDeduction: true,
      privateShare: 0,
      asset: false,
      privateShareJeZeile,
      onChange: () => undefined,
      onRateChange: () => undefined,
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

  it("zeigt in der Zeile die Auswahl der Art, standardmäßig Prozent", () => {
    const html = render("Hinweis");
    expect(html).toContain('aria-label="Art des Privatanteils in Zeile 1"');
    expect(html).toContain(">Prozent</option>");
    expect(html).toContain('value="25"');
  });
});

describe("Privatbetrag je Zeile", () => {
  it("nimmt einen Privatbetrag netto und brutto in die Zeilen auf", () => {
    expect(parseSplitRows([splitRow("software", 1900, "12,99", "", "", "12,99", "brutto")])).toEqual([
      { category: "software", taxRate: 1900, net: 1299, ownAccountId: null, privateShare: 0, privateAmount: 1299, privateAmountBasis: "brutto" },
    ]);
    expect(parseSplitRows([splitRow("software", 1900, "20,00", "", "", "5,00")])).toEqual([
      { category: "software", taxRate: 1900, net: 2000, ownAccountId: null, privateShare: 0, privateAmount: 500, privateAmountBasis: "netto" },
    ]);
  });

  it("schaltet zwischen Prozent und Betrag um, ohne den anderen Wert mitzuschicken", () => {
    const prozent = splitRow("telefon", 1900, "60,00", "", "25");
    const betrag = { ...prozent, ...wechslePrivatmodus(prozent, "brutto") };
    expect(betrag.privateModus).toBe("brutto");
    expect(betrag.privateShare).toBe("0");
    // Auch mit einem Betrag bleibt der Prozentwert 0; sonst schlüge die Prüfung auf dem Server zu
    expect(parseSplitRows([{ ...betrag, privateAmount: "5,00" }])![0]).toMatchObject({ privateShare: 0, privateAmount: 500, privateAmountBasis: "brutto" });

    const zurueck = { ...betrag, privateAmount: "5,00", ...wechslePrivatmodus(betrag, "prozent") };
    expect(zurueck.privateAmount).toBe("");
    expect(parseSplitRows([zurueck])![0]).toEqual({ category: "telefon", taxRate: 1900, net: 6000, ownAccountId: null, privateShare: 0 });
  });

  it("meldet einen Privatbetrag über dem Netto beziehungsweise Brutto der Zeile", () => {
    const zeile = (betrag: string, basis?: "netto" | "brutto") => splitRow("software", 1900, "10,00", "", "", betrag, basis);
    expect(privatanteilFehler(zeile("10,00"))).toBeNull();
    expect(privatanteilFehler(zeile("11,00"))).toBe("Der Privatbetrag ist größer als der Nettobetrag der Zeile.");
    // Brutto 11,90 € zu 19 % passen in die Zeile, 12,00 € nicht mehr
    expect(privatanteilFehler(zeile("11,90", "brutto"))).toBeNull();
    expect(privatanteilFehler(zeile("12,00", "brutto"))).toBe("Der Privatbetrag ist größer als der Bruttobetrag der Zeile.");
    expect(privatanteilFehler(zeile("abc"))).toContain("Trag den Privatbetrag ein");
    expect(privatanteilFehler(zeile(""))).toBeNull();
    expect(parseSplitRows([zeile("11,00")])).toBeNull();
  });

  it("zählt einen Privatbetrag als Privatanteil in den Zeilen", () => {
    expect(privatanteilInZeilen([splitRow("software", 1900, "12,99", "", "", "12,99", "brutto")])).toBe(true);
    expect(privatanteilInZeilen([splitRow("software", 1900, "12,99", "", "", "")])).toBe(false);
  });

  it("gibt beim Aufheben bei einem Betrag 0 Prozent zurück", () => {
    // Am Beleg gibt es keinen Betrag, nur einen Prozentwert; der Betrag bleibt in der Zeile
    expect(anteilBeimAufheben([splitRow("software", 1900, "12,99", "", "", "12,99", "brutto")])).toBe("0");
    expect(anteilBeimAufheben([splitRow("software", 1900, "12,99", "", "", "12,99"), splitRow("telefon", 1900, "60,00", "", "40")])).toBe("0");
  });

  it("zeigt bei einem Betrag das Betragsfeld statt des Prozentfelds", () => {
    const html = renderZeilen([splitRow("software", 1900, "12,99", "", "", "12,99", "brutto")], "Hinweis");
    expect(html).toContain('value="12,99"');
    expect(html).toContain('placeholder="0,00"');
    expect(html).not.toContain('placeholder="0"');
  });

  it("deckt im Hinweis unter der Beträge-Karte Prozent und Betrag ab", () => {
    const hinweis = vorschau(privatanteilInZeilen([splitRow("software", 1900, "12,99", "", "", "12,99", "brutto")]));
    expect(hinweis).toContain("als Prozent oder als Betrag, netto oder brutto");
  });
});
