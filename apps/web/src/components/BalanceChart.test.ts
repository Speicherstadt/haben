import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BalanceChart } from "./BalanceChart.tsx";

describe("BalanceChart: Grenze (#1381)", () => {
  it("zeichnet die Linie unter der Kurve, ihre Beschriftung darüber, damit die Kurve sie nicht übermalt", () => {
    const svg = renderToStaticMarkup(
      createElement(BalanceChart, {
        title: "Liquiditätsvorschau",
        from: "2026-11-20",
        to: "2026-12-20",
        start: 800_000,
        points: [{ date: "2026-12-10", value: 400_000, label: "Miete" }],
        grenze: { value: 500_000, label: "Mindestbestand" },
      }),
    );
    const linie = svg.indexOf('class="grenze"');
    const kurve = svg.indexOf('class="line-series"');
    const beschriftung = svg.indexOf("grenze-label");
    expect(linie).toBeGreaterThan(-1);
    expect(linie).toBeLessThan(kurve);
    expect(beschriftung).toBeGreaterThan(kurve);
  });
});
