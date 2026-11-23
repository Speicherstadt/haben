import { computeUstva } from "@haben/core";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "./$zeitraum.tsx";

vi.mock("@tanstack/react-router", async (original) => {
  const router = await original<typeof import("@tanstack/react-router")>();
  const { createElement } = await import("react");
  return {
    ...router,
    useNavigate: () => vi.fn(),
    useRouter: () => ({ invalidate: vi.fn() }),
    Link: ({ children }: { children: ReactNode }) => createElement("a", null, children),
  };
});
vi.mock("@tanstack/react-start", async (original) => ({
  ...(await original<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("../../../server/functions/vat.ts", () =>
  Object.fromEntries(
    [
      "getVatPeriod",
      "getMeinElsterUstvaWerte",
      "saveVatDraft",
      "createVatCorrection",
      "submitVatReturn",
      "saveVatFrequency",
      "saveVatDauerfrist",
      "submitVatDauerfrist",
      "fileVatReturnElsewhere",
    ].map((name) => [name, vi.fn()]),
  ),
);
// Die Karten haben eigene Tests; hier zählt nur, ob und wo sie auf der Seite stehen
vi.mock("../../../components/umsatzsteuer/VatFrequencyCard.tsx", async (original) => ({
  ...(await original<typeof import("../../../components/umsatzsteuer/VatFrequencyCard.tsx")>()),
  VatFrequencyCard: () => createElement("i", { "data-karte": "zeitraum" }),
}));
vi.mock("../../../components/umsatzsteuer/DauerfristCard.tsx", () => ({ DauerfristCard: () => createElement("i", { "data-karte": "dauerfrist" }) }));

const zero = computeUstva({ kz81: 0, kz86: 0, kz66: 0 });

/** Eine Voranmeldung im Entwurf, ohne Buchungen; `current` null = noch nicht angelegt */
function seite(overrides: Record<string, unknown> = {}) {
  const data = {
    period: { year: 2026, month: 10 },
    current: null,
    returns: [],
    periods: [{ year: 2026, month: 10 }],
    frequency: { year: 2026, own: [], frequency: "monatlich", inherited: false, previousYearTax: null, suggestion: null },
    dauerfrist: { year: 2026, frequency: "monatlich", active: false, own: null, sent: false, vorschlag: null, submissions: [] },
    mode: "eric",
    herstellerIdConfigured: true,
    companyIssues: [],
    preflight: [],
    periodProblem: null,
    kleinunternehmer: false,
    kz39: 0,
    figures: { ...zero, versteuerung: "ist", revenue: [], inputTax: [], reverseCharge: [], igErwerb: [] },
    filings: [],
    submissions: [],
    recent: [],
    posten: [],
    dueDate: "2026-11-10",
    today: "2026-11-23",
    ...overrides,
  };
  vi.spyOn(Route, "useLoaderData").mockImplementation(() => data as unknown as ReturnType<typeof Route.useLoaderData>);
  return renderToStaticMarkup(createElement(Route.options.component as ComponentType));
}

const entwurfVonHand = {
  ...zero,
  id: "entwurf",
  source: "manuell",
  computed: zero,
  status: "draft",
  berichtigt: false,
  sentAt: null,
  updatedAt: new Date("2026-11-01T12:00:00Z"),
  overrideReason: "Werte aus der alten Buchhaltung übernommen",
};

afterEach(() => vi.restoreAllMocks());

describe("Voranmeldung: Werte von Hand ändern (#1253, Punkt 30)", () => {
  it("zeigt berechnete Werte ohne Eingabefelder und den Zugang als kleinen Link unter der Tabelle", () => {
    const html = seite();
    expect(html).toContain('<output id="kz-81"');
    expect(html).not.toContain('<input id="kz-81"');
    expect(html).toMatch(/<button type="button" class="link-button"[^>]*>Werte von Hand ändern \(nur wenn das Finanzamt es verlangt\)<\/button>/);
    expect(html).not.toContain("Manuell überschreiben");
    expect(html).not.toContain('class="mode-switch"');
    // Unter der Tabelle, nicht davor
    expect(html.indexOf("Werte von Hand ändern")).toBeGreaterThan(html.indexOf('id="kz-81"'));
  });

  it("zeigt einen schon von Hand überschriebenen Entwurf mit offenen Feldern, Begründung und dem Weg zurück", () => {
    const html = seite({ current: entwurfVonHand });
    expect(html).toContain('<input id="kz-81"');
    expect(html).toContain("Werte aus der alten Buchhaltung übernommen");
    expect(html).toMatch(/<button type="button" class="link-button"[^>]*>Zurück zu den berechneten Werten<\/button>/);
    expect(html).not.toContain("Werte von Hand ändern");
  });
});
