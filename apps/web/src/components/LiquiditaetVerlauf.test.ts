import { liquiditaetsVorschau } from "@haben/core";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LiquiditaetVerlauf } from "./LiquiditaetVerlauf.tsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => createElement("a", { href: to }, children),
}));

// Eine Darlehensrate (#1381) im aufgeklappten Zeitraum: Der Inhaber springt zu den Darlehen, die Steuerberatung sieht den Text
const vorschau = liquiditaetsVorschau({
  heute: "2026-11-20",
  horizont: "4w",
  start: 5000_00,
  posten: [
    {
      datum: "2026-11-30",
      betrag: 1000_00,
      richtung: "aus",
      text: "Hausbank, Rate wie zuletzt gezahlt",
      quelle: { art: "darlehen", id: "d1" },
      sicherheit: "erwartet",
    },
  ],
});
const zeile = (rolle: string) => renderToStaticMarkup(createElement(LiquiditaetVerlauf, { vorschau, offen: "2026-11-30", rolle }));

describe("Liquiditätsvorschau: Darlehensrate im Zeitraum", () => {
  it("verlinkt für den Inhaber auf die Darlehen", () => {
    expect(zeile("inhaber")).toContain('Darlehen</span> <a href="/darlehen">Hausbank, Rate wie zuletzt gezahlt</a>');
  });

  it("zeigt der Steuerberatung, die die Darlehen nicht öffnen kann, nur den Text", () => {
    const html = zeile("steuerberatung");
    expect(html).toContain("Darlehen</span> Hausbank, Rate wie zuletzt gezahlt");
    expect(html).not.toContain('href="/darlehen"');
  });
});
