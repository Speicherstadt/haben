import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrivatanteilVorgaben, privatanteilFehler, privatanteilTexte, privatanteilWerte } from "./PrivatanteilVorgaben.tsx";

describe("Vorgaben für den Privatanteil (#1221)", () => {
  it("liest ganze Prozent von 0 bis 100, auch mit „%“; leer und 0 heißen kein Anteil", () => {
    const texte = { telefon: "20 %", internet: "" };
    expect(privatanteilFehler(texte, false)).toEqual({ "privateShare-telefon": null, "privateShare-internet": null });
    expect(privatanteilWerte(texte, false)).toEqual({ telefon: 20 });
    expect(privatanteilWerte({ telefon: "0", internet: "100" }, false)).toEqual({ internet: 100 });
  });

  it("meldet am Feld, was keine ganze Zahl von 0 bis 100 ist, statt es still zu verwerfen", () => {
    for (const text of ["20,5", "150", "abc", "-5"]) {
      expect(privatanteilFehler({ telefon: text, internet: "" }, false)["privateShare-telefon"], text).toBe("Trag eine ganze Zahl von 0 bis 100 ein.");
    }
  });

  it("hat in einer Kapitalgesellschaft weder Felder noch Fehler noch Werte", () => {
    expect(privatanteilFehler({ telefon: "abc", internet: "" }, true)).toEqual({ "privateShare-telefon": null, "privateShare-internet": null });
    expect(privatanteilWerte({ telefon: "20", internet: "" }, true)).toEqual({});
  });

  it("zeigt gespeicherte Vorgaben als Text", () => {
    expect(privatanteilTexte({ telefon: 20 })).toEqual({ telefon: "20", internet: "" });
  });
});

describe("Hinweis unter den Vorgaben (#1261)", () => {
  const hinweis = (abzug: boolean) =>
    renderToStaticMarkup(
      createElement(PrivatanteilVorgaben, { texte: { telefon: "", internet: "" }, abzug, onChange() {}, error: () => undefined, offen: true, onOffen() {} }),
    );

  it("nennt die Vorsteuer nur mit Vorsteuerabzug", () => {
    expect(hinweis(true)).toContain("Nur der betriebliche Teil wird Ausgabe und Vorsteuer, der private Teil ist eine Entnahme.");
    expect(hinweis(false)).toContain("Nur der betriebliche Teil wird Ausgabe, der private Teil ist eine Entnahme.");
    expect(hinweis(false)).not.toContain("Vorsteuer");
  });
});
