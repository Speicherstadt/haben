import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AccountCombobox } from "./AccountCombobox.tsx";

const accounts: Record<string, string> = {
  "1200": "Geschäftskonto",
  "1205": "Girokonto",
  "1400": "Forderungen aus Lieferungen und Leistungen",
  "4400": "Erlöse aus Leistungen",
  "9000": "Saldenvorträge Sachkonten",
};

const render = (value = "") =>
  renderToStaticMarkup(createElement(AccountCombobox, { index: 0, value, accounts, invalid: false, onInput: () => {}, onPick: () => {} }));

describe("AccountCombobox", () => {
  it("trägt die Kontonummer ins Feld", () => {
    expect(render("1200")).toContain("1200");
  });

  it("benennt das Feld je Zeile", () => {
    expect(render()).toContain("Konto Zeile 1");
    const zweite = renderToStaticMarkup(createElement(AccountCombobox, { index: 3, value: "", accounts, invalid: false, onInput: () => {}, onPick: () => {} }));
    expect(zweite).toContain("Konto Zeile 4");
  });

  it("markiert ein ungültiges Feld", () => {
    const html = renderToStaticMarkup(createElement(AccountCombobox, { index: 0, value: "", accounts, invalid: true, onInput: () => {}, onPick: () => {} }));
    expect(html).toContain('aria-invalid="true"');
  });
});

const combobox = (value: string, onPick = (_account: { number: string; name: string }) => {}) =>
  AccountCombobox({ index: 0, value, accounts, invalid: false, onInput: () => {}, onPick });

const numbers = (value: string) =>
  combobox(value)
    .props.search()
    .hits.map((account: { number: string }) => account.number);

describe("Kontensuche", () => {
  it("findet Nummern am Anfang, aber nicht mitten in einer Nummer", () => {
    expect(numbers("12")).toEqual(["1200", "1205"]);
    expect(numbers("20")).toEqual([]);
    expect(numbers(" 1200 ")).toEqual(["1200"]);
  });

  it("findet Teilstrings im Namen unabhängig von Großschreibung und Umlauten", () => {
    expect(numbers("GIRO")).toEqual(["1205"]);
    expect(numbers("schafts")).toEqual(["1200"]);
    expect(numbers("erlose")).toEqual(["4400"]);
  });

  it("liefert bei unbekannten Namen keine Treffer", () => {
    expect(numbers("Unbekanntes Konto")).toEqual([]);
  });

  it("zeigt bei leerer Eingabe wieder die verfügbaren Konten", () => {
    expect(numbers("")).toEqual(Object.keys(accounts));
  });

  it("zeigt die Nummer vor der Bezeichnung wie die Kategorien", () => {
    const element = combobox("giro");
    expect(element.props.describe({ number: "1205", name: "Girokonto" })).toMatchObject({ label: "1205 · Girokonto" });
    expect(element.props.describe({ number: "1205", name: "Girokonto" }).meta).toBeUndefined();
  });

  it("übergibt den gewählten Treffer mit seiner Kontonummer", () => {
    const onPick = vi.fn();
    const element = combobox("giro", onPick);
    const account = element.props.search().hits[0];
    element.props.onPick(account);
    expect(onPick).toHaveBeenCalledExactlyOnceWith({ number: "1205", name: "Girokonto" });
  });
});
