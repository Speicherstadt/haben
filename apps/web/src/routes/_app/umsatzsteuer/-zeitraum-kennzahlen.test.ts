import { computeUstva } from "@haben/core";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => createElement("a", null, children) }));
import { type FieldKey, KennzahlenTabelle } from "./-zeitraum-kennzahlen.tsx";
import type { PageData } from "./-zeitraum-quellen.tsx";

const FELDER: FieldKey[] = [
  "kz81",
  "kz86",
  "kz21",
  "kz45",
  "kz48",
  "kz66",
  "kz46",
  "kz47",
  "kz84",
  "kz85",
  "kz67",
  "kz39",
  "kz41",
  "kz43",
  "kz89",
  "kz93",
  "kz61",
  "kz62",
];
const leer = computeUstva({ kz81: 0, kz86: 0, kz66: 0 });
const data = { figures: { revenue: [], kleinunternehmerUmsaetze: [], inputTax: [], reverseCharge: [], igErwerb: [] } } as unknown as PageData;

function tabelle(feld: FieldKey, wert: string) {
  const values = { ...(Object.fromEntries(FELDER.map((f) => [f, "0,00"])) as Record<FieldKey, string>), [feld]: wert };
  const fehler = (f: FieldKey) => (f === feld ? "Trag den Betrag der Kennzahl ein, etwa 1.234,56." : undefined);
  // Von Hand: ein nicht lesbarer Betrag zählt in `shown` als 0 (manualFigures), die Buchungen ergeben dort auch 0
  const eingabe = { locked: false, editable: true, values, fehler, update: () => {}, openSources: null, toggleSources: () => {} };
  return renderToStaticMarkup(createElement(KennzahlenTabelle, { data, shown: leer, computed: leer, eingabe }));
}

// #1270: Ein Feld, das die Prüfung beim Speichern als ungültig meldet, muss samt Meldung zu sehen sein, sonst bricht
// „Entwurf speichern“ ohne sichtbaren Grund ab und der Fokus findet kein Feld
describe("Kennzahlen von Hand mit ungültigem Betrag", () => {
  it.each([
    ["kz62", "kz-62"],
    ["kz39", "kz-39"],
  ] as const)("zeigt %s samt Meldung, auch wenn Buchungen und Eingabe dort 0 ergeben", (feld, id) => {
    const html = tabelle(feld, "");
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain(`id="${id}-fehler"`);
  });
});
