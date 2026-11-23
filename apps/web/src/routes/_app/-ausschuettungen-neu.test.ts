import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({}) }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("../../server/functions/ausschuettung.ts", () => ({ createAusschuettungFn: vi.fn(), previewAusschuettung: vi.fn() }));
import { VorschlagMeldungen } from "./-ausschuettungen-neu.tsx";

const grund = "Der Gewinnvortrag zum Beschluss beträgt 25.000,00 €; mehr lässt sich nicht ausschütten.";
const hinweis = "Für 2026 passt der Anteil in Prozent nicht zur Beteiligung in Euro: Erika Gesellschafter 60 % (nach der Beteiligung 50 %).";

/* #1286: Der Grund sperrt „Beschluss buchen“, der Hinweis nicht; man soll sehen, welcher Banner den Knopf sperrt */
it("zeigt den sperrenden Grund als Warnung und den Hinweis als banner-info, den Grund zuerst", () => {
  const html = renderToStaticMarkup(createElement(VorschlagMeldungen, { issues: [grund], hinweise: [hinweis] }));
  expect(html).toBe(`<div class="banner" role="status">${grund}</div><div class="banner banner-info" role="status">${hinweis}</div>`);
});

it("zeigt ohne Grund und Hinweis nichts", () => {
  expect(renderToStaticMarkup(createElement(VorschlagMeldungen, { issues: [], hinweise: [] }))).toBe("");
});
