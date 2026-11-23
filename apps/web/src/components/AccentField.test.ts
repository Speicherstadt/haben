import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AccentField, hexAusEingabe } from "./AccentField.tsx";

/* Farbe in der Spalte Gestaltung (#1674): Schwarz als Vorschlag, Hex-Wert direkt eingeben */

const html = (accent: string, fromLayout = false, layoutAccent?: string) =>
  renderToStaticMarkup(createElement(() => AccentField({ accent, fromLayout, layoutAccent, onChange: () => {} })));

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

  it("bietet sieben Punkte an: Schwarz ersetzt das fast gleich aussehende Grau, das als eigene Farbe weiter gilt", () => {
    const markup = html("#3F4A44");
    expect(markup).not.toMatch(/aria-label="Grau"/);
    expect(markup.match(/class="color-swatch[ "]/g)).toHaveLength(7);
    expect(markup).toMatch(/<label[^>]*class="color-swatch color-swatch-custom"[^>]*data-active="true"/);
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

  it("begrenzt das Feld nicht auf 7 Zeichen, damit ein eingefügter Wert mit Leerzeichen ganz ankommt und trim() ihn liest", () => {
    expect(html("#123456")).not.toMatch(/maxlength/i);
  });

  it("öffnet den Farbwähler mit „Farbe des Layouts“ auf der Farbe des Layouts, wie das Feld Hex-Wert", () => {
    expect(html("#1F6F5C", true, "#B5862A")).toMatch(/<input[^>]*type="color"[^>]*value="#b5862a"/);
  });

  it("zeigt mit „Farbe des Layouts“ die Farbe, die auf den Belegen steht, nicht die gespeicherte eigene", () => {
    const markup = html("#1F6F5C", true, "#B5862A");
    expect(markup).toMatch(/<input[^>]*class="mono"[^>]*value="#B5862A"/);
  });
});

/** Alle Elemente des Baums, den AccentField zurückgibt, ohne ihn zu rendern */
function elemente(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as ReactElement<{ children?: ReactNode }>;
  return [el as ReactElement<Record<string, unknown>>, ...[el.props.children].flat(Infinity).flatMap((kind) => elemente(kind as ReactNode))];
}

describe("AccentField: Eingabe im Feld Hex-Wert", () => {
  it("schaltet „Farbe des Layouts“ aus, auch wenn der Wert der gespeicherten eigenen Farbe gleicht (Codex-Review #1687)", () => {
    const onChange = vi.fn();
    let baum: ReactNode;
    renderToStaticMarkup(
      createElement(() => {
        baum = AccentField({ accent: "#1f6f5c", fromLayout: true, layoutAccent: "#B5862A", onChange });
        return baum as ReactElement;
      }),
    );
    const feld = elemente(baum).find((el) => el.props.label === "Hex-Wert")!;
    const eingabe = (feld.props.children as (control: object) => ReactElement<{ onChange: (event: object) => void }>)({});
    eingabe.props.onChange({ target: { value: "#1F6F5C" } });
    expect(onChange).toHaveBeenCalledWith({ accent: "#1F6F5C", accentFromLayout: false });
  });
});
