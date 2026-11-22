import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccentField, hexAusEingabe } from "./AccentField.tsx";

/* Farbe in der Spalte Gestaltung (#1674): Schwarz als Vorschlag, Hex-Wert direkt eingeben */

const html = (accent: string, fromLayout = false) => renderToStaticMarkup(createElement(() => AccentField({ accent, fromLayout, onChange: () => {} })));

describe("hexAusEingabe", () => {
  it("nimmt #RRGGBB in jeder Schreibweise und gibt Großbuchstaben zurück", () => {
    expect(hexAusEingabe("#1d4e89")).toBe("#1D4E89");
    expect(hexAusEingabe("  #1D4E89 ")).toBe("#1D4E89");
  });

  it("ergänzt das fehlende #, wie es beim Kopieren aus anderen Programmen oft fehlt", () => {
    expect(hexAusEingabe("000000")).toBe("#000000");
  });

  it("lehnt unvollständige und fremde Werte ab, damit beim Tippen nichts Halbes ins Blatt geht", () => {
    for (const text of ["", "#", "#12345", "#1234567", "#GGGGGG", "rgb(0,0,0)", "#fff"]) expect(hexAusEingabe(text)).toBeNull();
  });
});

describe("AccentField", () => {
  it("bietet Schwarz als Vorschlag an", () => {
    expect(html("#1F6F5C")).toMatch(/<button[^>]*aria-label="Schwarz"[^>]*>/);
  });

  it("zeigt Schwarz als gewählt, wenn es die eigene Farbe ist", () => {
    expect(html("#000000")).toMatch(/<button[^>]*aria-label="Schwarz"[^>]*aria-pressed="true"/);
  });

  it("hat ein Feld für den Hex-Wert mit der aktuellen Farbe", () => {
    const markup = html("#123456");
    const id = /<label[^>]*for="([^"]+)"[^>]*>Hex-Wert<\/label>/.exec(markup)?.[1];
    expect(id).toBeTruthy();
    expect(markup).toMatch(new RegExp(`<input[^>]*id="${id}"[^>]*value="#123456"`));
  });
});
