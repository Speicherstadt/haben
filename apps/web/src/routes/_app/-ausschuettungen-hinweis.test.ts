import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("../../server/functions/ausschuettung.ts", () => ({
  getAusschuettungen: {},
  createAusschuettungFn: {},
  previewAusschuettung: {},
  reverseAusschuettungFn: {},
  submitKapEStFn: {},
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: () => async () => ({}) }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options, useLoaderData: () => state.data }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => createElement("a", { href: to }, children),
  useNavigate: () => async () => {},
  useRouter: () => ({ invalidate: async () => {} }),
}));
import { Route } from "./ausschuettungen.tsx";

const seite = (daten: Record<string, unknown>) => {
  state.data = {
    year: 2026,
    rechtsform: "gmbh",
    ausschuettungen: [],
    today: "2026-07-01",
    certificate: null,
    herstellerIdConfigured: false,
    mode: "simuliert",
    ...daten,
  };
  const Seite = (Route as unknown as { options: { component: ComponentType } }).options.component;
  return renderToStaticMarkup(createElement(Seite));
};

describe("Ausschüttungen: Hinweis bei fehlendem ERiC", () => {
  it("zeigt ohne ERiC, dass die Kapitalertragsteuer-Anmeldung nichts ans Finanzamt schickt", () => {
    expect(seite({})).toContain("ERiC ist nicht eingerichtet. Prüfen und Senden laufen simuliert, nichts geht an das Finanzamt.");
  });

  it("zeigt ihn mit ERiC nicht", () => {
    expect(seite({ mode: "eric" })).not.toContain("ERiC ist nicht eingerichtet");
  });

  it("zeigt ihn im Einzelunternehmen nicht: dort gibt es keine Ausschüttung und nichts zu senden", () => {
    expect(seite({ rechtsform: "einzelunternehmen" })).not.toContain("ERiC ist nicht eingerichtet");
  });
});
