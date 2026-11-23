import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEMES } from "./theme.ts";

/**
 * Farbkontraste aller Themes direkt an den Farb-Tokens in styles.css, nach der Formel aus WCAG 2.2 (relative
 * Leuchtdichte, Erfolgskriterium 1.4.3: 4,5 : 1 für Text). axe prüft im Browser nur das Standard-Theme Wald
 * (e2e/barrierefreiheit.spec.ts); die übrigen Farben unterscheiden sich nur in diesen Tokens.
 */

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const FARBEN = THEMES.map((theme) => theme.id);

/** Die Deklarationen des ersten Blocks mit genau diesem Selektor am Zeilenanfang */
function block(selektor: string): Record<string, string> {
  const start = css.indexOf(`\n${selektor} {`);
  if (start < 0) throw new Error(`${selektor} fehlt in styles.css`);
  const offen = css.indexOf("{", start) + 1;
  const text = css.slice(offen, css.indexOf("}", offen));
  return Object.fromEntries([...text.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

/** Tokens einer Farbe in einem Modus, in der Reihenfolge der Kaskade, var() aufgelöst */
function tokens(farbe: (typeof FARBEN)[number], dunkel: boolean): Record<string, string> {
  const t: Record<string, string> = {
    ...block(":root"),
    ...(farbe === "wald" ? {} : block(`[data-theme="${farbe}"]`)),
    ...(dunkel ? block('[data-mode="dark"]') : {}),
    ...(dunkel && farbe !== "wald" ? block(`[data-theme="${farbe}"][data-mode="dark"]`) : {}),
  };
  const aufloesen = (wert: string, tiefe = 0): string => {
    const ref = wert.match(/^var\((--[\w-]+)\)$/);
    return ref && tiefe < 5 ? aufloesen(t[ref[1]!] ?? "", tiefe + 1) : wert;
  };
  return Object.fromEntries(Object.entries(t).map(([name, wert]) => [name, aufloesen(wert)]));
}

function leuchtdichte(hex: string): number {
  const h = hex.replace("#", "");
  const voll = h.length === 3 ? [...h].map((z) => z + z).join("") : h;
  if (!/^[0-9a-f]{6}$/i.test(voll)) throw new Error(`keine Farbe: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(voll.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Schrift mit Deckkraft über ihrer Fläche gemischt, wie der Browser sie malt */
function mischen(schrift: string, flaeche: string, deckkraft: number): string {
  const kanal = (hex: string, i: number) => Number.parseInt(hex.replace("#", "").slice(i, i + 2), 16);
  return `#${[0, 2, 4]
    .map((i) =>
      Math.round(kanal(schrift, i) * deckkraft + kanal(flaeche, i) * (1 - deckkraft))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function kontrast(a: string, b: string): number {
  const [hell, dunkel] = [leuchtdichte(a), leuchtdichte(b)].sort((x, y) => y - x);
  return (hell! + 0.05) / (dunkel! + 0.05);
}

const FLAECHEN = ["--ground", "--surface"];
/** Schrift → Flächen, auf denen sie steht; jedes Paar braucht 4,5 : 1 */
const PAARE: [string, string[]][] = [
  ["--ink", [...FLAECHEN, "--accent-soft", "--accent-tint"]],
  ["--ink-2", FLAECHEN],
  ["--muted", FLAECHEN],
  ["--link", FLAECHEN],
  ["--accent-ink", [...FLAECHEN, "--accent-soft", "--accent-tint"]],
  ["--accent-fg", ["--accent", "--accent-hover"]],
  ["--nav-ink", ["--nav", "--nav-active"]],
  ["--nav-ink-strong", ["--nav", "--nav-active"]],
  ["--warn-ink", [...FLAECHEN, "--warn-soft"]],
  ["--info-ink", [...FLAECHEN, "--info-soft"]],
  ["--danger-ink", [...FLAECHEN, "--danger-soft"]],
];

describe("Farbkontraste der Themes (WCAG 1.4.3)", () => {
  for (const farbe of FARBEN)
    for (const dunkel of [false, true])
      it(`${farbe}${dunkel ? " dunkel" : ""}: Schrift auf ihren Flächen mindestens 4,5 : 1`, () => {
        const t = tokens(farbe, dunkel);
        const zuWenig = PAARE.flatMap(([schrift, flaechen]) =>
          flaechen
            .map((flaeche) => ({ paar: `${schrift} auf ${flaeche}`, wert: Math.round(kontrast(t[schrift]!, t[flaeche]!) * 100) / 100 }))
            .filter(({ wert }) => wert < 4.5),
        );
        // Gruppennamen, Rolle und Version der Navigation tragen opacity 0.7 (.nav-group-label, .nav-user-meta)
        const blass = kontrast(mischen(t["--nav-ink"]!, t["--nav"]!, 0.7), t["--nav"]!);
        expect(zuWenig).toEqual([]);
        expect(blass, "--nav-ink mit 0.7 auf --nav").toBeGreaterThanOrEqual(4.5);
      });

  it("rechnet wie WCAG: Schwarz auf Weiß 21 : 1, #777 auf Weiß 4,48 : 1", () => {
    expect(kontrast("#000", "#fff")).toBeCloseTo(21, 5);
    expect(kontrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it("liest die Kaskade aus styles.css: Ozean dunkel mit eigenem Akzent, Links hell und dunkel", () => {
    expect(tokens("ozean", true)["--accent"]).toBe("#6aa8f0");
    expect(tokens("ozean", true)["--link"]).toBe("#93bdf0");
    expect(tokens("ozean", true)["--ground"]).toBe("#111113");
    expect(tokens("wald", false)["--link"]).toBe("#1f6f5c");
  });
});
