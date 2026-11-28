import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BalanceChart, grenzeLabelSeite } from "./BalanceChart.tsx";

// Breite des Diagramms: im Browser gemessen, beim Rendern auf dem Server 720
const breite = vi.hoisted(() => ({ wert: 720 }));
vi.mock("../lib/chart.ts", async (original) => ({ ...(await original<typeof import("../lib/chart.ts")>()), useChartWidth: () => [() => {}, breite.wert] }));

/** Kurve von 8.000 € über 4.000 € bis ende, Grenze bei 5.000 € */
const chart = (ende: number) =>
  renderToStaticMarkup(
    createElement(BalanceChart, {
      title: "Liquiditätsvorschau",
      from: "2026-11-20",
      to: "2026-12-20",
      start: 800_000,
      points: [
        { date: "2026-12-01", value: 400_000, label: "Miete" },
        { date: "2026-12-05", value: ende, label: "Zahlung" },
      ],
      grenze: { value: 500_000, label: "Mindestbestand" },
    }),
  );
/** Zahl im Attribut name des Elements mit genau dieser Klasse */
const attr = (svg: string, klasse: string, name: string) =>
  Number(svg.match(new RegExp(`<[a-z]+[^>]*class="${klasse}"[^>]*>`))?.[0].match(new RegExp(` ${name}="([^"]+)"`))?.[1]);

describe("BalanceChart: Grenze (#1381)", () => {
  it("zeichnet die Linie unter der Kurve und die Beschriftung danach, ohne Rand: überlappen sie sich, bleiben beide sichtbar", () => {
    const svg = chart(300_000);
    const linie = svg.indexOf('class="grenze"');
    const kurve = svg.indexOf('class="line-series"');
    expect(linie).toBeGreaterThan(-1);
    expect(linie).toBeLessThan(kurve);
    expect(svg.indexOf("grenze-label")).toBeGreaterThan(kurve);
  });

  it("setzt die Beschriftung unter die Linie, wenn die Kurve am rechten Ende knapp darüber liegt", () => {
    const linie = attr(chart(300_000), "grenze", "y1");
    expect(attr(chart(300_000), "tick grenze-label", "y")).toBeLessThan(linie);
    expect(attr(chart(520_000), "tick grenze-label", "y")).toBeGreaterThan(linie);
  });

  it("bleibt über der Achse der Monate, wenn die Grenze unten auf der Nulllinie liegt (0 €) und die Kurve knapp darüber endet", () => {
    // Am Handy (330 px) 13 Wochen ab 20.11.: „Jan“ steht unter dem rechten Ende der Linie
    breite.wert = 330;
    const svg = renderToStaticMarkup(
      createElement(BalanceChart, {
        title: "Liquiditätsvorschau",
        from: "2026-11-20",
        to: "2027-02-18",
        start: 800_000,
        points: [{ date: "2026-12-01", value: 10_000, label: "Miete" }],
        grenze: { value: 0, label: "Mindestbestand" },
      }),
    );
    breite.wert = 720;
    const nulllinie = attr(svg, "grenze", "y1");
    expect(nulllinie).toBe(attr(svg, "axis-base", "y1"));
    // Die Beschriftung reicht rechtsbündig bis 318, grob 7 px je Zeichen
    expect(Number(svg.match(/<text x="([^"]+)"[^>]*>Jan<\/text>/)?.[1])).toBeGreaterThan(318 - "Mindestbestand".length * 7);
    expect(attr(svg, "tick grenze-label", "y")).toBeLessThanOrEqual(nulllinie);
  });
});

describe("Beschriftung der Grenze: oben oder unten (#1381)", () => {
  // Grenze bei y = 100, Beschriftung von x = 600 bis 700; y wächst nach unten
  const seite = (...stufen: [number, number][]) =>
    grenzeLabelSeite(
      stufen.map(([x, y]) => ({ x, y })),
      600,
      700,
      100,
    );

  it("oben, solange die Kurve dort das Band über der Linie frei lässt", () => {
    expect(seite([0, 150], [720, 150])).toBe("oben");
    expect(seite([0, 105], [720, 105])).toBe("oben");
    expect(seite([0, 100], [720, 100])).toBe("oben");
    // Knapp über der Linie, aber nur links der Beschriftung
    expect(seite([0, 95], [500, 95], [500, 150], [720, 150])).toBe("oben");
    // Eine senkrechte Stufe durch das Band zählt nicht
    expect(seite([0, 50], [650, 50], [650, 150], [720, 150])).toBe("oben");
  });

  it("unten, wenn die Kurve dort im Band direkt über der Linie verläuft, auch wenn sie von unten heraufsteigt", () => {
    expect(seite([0, 150], [650, 150], [650, 95], [720, 95])).toBe("unten");
  });

  it("oben, wenn die Kurve dort beide Bänder belegt", () => {
    expect(seite([0, 95], [650, 95], [650, 105], [720, 105])).toBe("oben");
  });
});
