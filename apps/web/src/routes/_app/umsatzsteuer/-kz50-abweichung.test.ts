import { computeUstva } from "@haben/core";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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
vi.mock("../../../components/umsatzsteuer/VatFrequencyCard.tsx", () => ({ VatFrequencyCard: () => null }));
vi.mock("../../../components/umsatzsteuer/DauerfristCard.tsx", () => ({ DauerfristCard: () => null }));

/*
 * #1267: Eine vor Kz 50 gesendete Anmeldung mit Forderungsausfall hat Kz 81/86 gemindert und Kz 50 leer. Der Abgleich
 * gesendeter Anmeldungen (gesendet-pruefen.ts) vergleicht Kz 50 nicht, weil sie keine Steuer ändert; die Seite des
 * Zeitraums darf deshalb auch nicht melden, die Buchungen hätten sich seit der Übermittlung geändert.
 */
describe("Gesendete Voranmeldung von vor Kz 50 (#1267)", () => {
  // Berechnet gesendet: Kz 50 = 0 (Standardwert der Migration); von Hand überschrieben: `computed` ohne Kz 50
  it.each(["berechnet", "manuell"])("%s: meldet keine Änderung seit der Übermittlung, nur weil Kz 50 jetzt gefüllt wäre", (source) => {
    const gesendet = computeUstva({ kz81: -100_000, kz86: -50_000, kz66: 0 });
    const { kz50: _ohne, ...altesComputed } = gesendet;
    const current = {
      ...gesendet,
      id: "alte-anmeldung",
      source,
      computed: altesComputed,
      status: "sent",
      berichtigt: false,
      sentAt: new Date("2026-11-08T12:00:00Z"),
      updatedAt: new Date("2026-11-08T12:00:00Z"),
    };
    const data = {
      period: { year: 2026, month: 10 },
      current,
      returns: [current],
      periods: [{ year: 2026, month: 10 }],
      frequency: { year: 2026, own: [], frequency: "monatlich", inherited: false, previousYearTax: null, suggestion: null },
      dauerfrist: { year: 2026, frequency: "monatlich", active: false, own: null, sent: false, vorschlag: null, submissions: [] },
      mode: "eric",
      herstellerIdConfigured: true,
      companyIssues: [],
      preflight: [],
      periodProblem: null,
      kleinunternehmer: false,
      uebernommen: false,
      kz39: 0,
      // Heute aus dem Journal: dieselben Kz 81/86, dazu Kz 50
      figures: {
        ...computeUstva({ kz81: -100_000, kz86: -50_000, kz66: 0, kz50: 150_000 }),
        kz48Kleinunternehmer: 0,
        revenue: [],
        inputTax: [],
        reverseCharge: [],
        igErwerb: [],
        kleinunternehmerUmsaetze: [],
      },
      filings: [],
      submissions: [],
      recent: [],
      posten: [],
      dueDate: "2026-11-10",
      today: "2026-11-23",
    };
    vi.spyOn(Route, "useLoaderData").mockImplementation(() => data as unknown as ReturnType<typeof Route.useLoaderData>);
    const Page = Route.options.component as ComponentType;
    const html = renderToStaticMarkup(createElement(Page));
    expect(html).not.toContain("Seit der Übermittlung haben sich die Buchungen dieses Monats geändert");
    vi.restoreAllMocks();
  });
});
