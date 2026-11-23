import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("../../../server/functions/lstb.ts", () => ({ getLstb: {}, stornoLstbFn: {}, submitLstbFn: {}, vermerkeLstbFn: {} }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: () => async () => ({}) }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options, useLoaderData: () => state.data }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => createElement("a", { href: to }, children),
  notFound: () => new Error("notFound"),
  useNavigate: () => async () => {},
  useRouter: () => ({ invalidate: async () => {} }),
}));
import { Route } from "./bescheinigung.$jahr.tsx";

const seite = (daten: Record<string, unknown>) => {
  state.data = {
    year: 2025,
    frist: "2026-02-28",
    ohneSchnittstelle: null,
    firmenfehler: [],
    mitarbeiter: [],
    heute: "2026-01-15",
    certificate: null,
    herstellerIdConfigured: false,
    mode: "simuliert",
    ...daten,
  };
  const Seite = (Route as unknown as { options: { component: ComponentType } }).options.component;
  return renderToStaticMarkup(createElement(Seite));
};

describe("Lohnsteuerbescheinigung: Hinweis bei fehlendem ERiC", () => {
  it("zeigt ohne ERiC, dass nichts ans Finanzamt geht", () => {
    expect(seite({})).toContain("ERiC ist nicht eingerichtet. Prüfen und Senden laufen simuliert, nichts geht an das Finanzamt.");
  });

  it("zeigt ihn mit ERiC nicht", () => {
    expect(seite({ mode: "eric" })).not.toContain("ERiC ist nicht eingerichtet");
  });

  it("zeigt ihn nicht, wo ERiC die Bescheinigung nicht sendet: der Weg läuft dann über Mein ELSTER", () => {
    expect(seite({ year: 2026, ohneSchnittstelle: "Für 2026 gibt es keine Schnittstelle." })).not.toContain("ERiC ist nicht eingerichtet");
  });
});
