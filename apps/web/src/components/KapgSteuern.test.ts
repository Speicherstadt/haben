import { formatEuro, kapgSteuern } from "@haben/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { KapgSteuern } from "./KapgSteuern.tsx";

vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({}) }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("../server/functions/abschluss.ts", () => ({ bookSteuerrueckstellungenFn: vi.fn(), saveKapgAngabenFn: vi.fn() }));

it("zeigt die negative Gewerbesteuer-Hinzurechnung in der Rechnung zum Gewerbeertrag", () => {
  const angaben = { hebesatz: 400, verlustvortragKst: 0, verlustvortragGewst: 0 };
  const steuern = kapgSteuern("SKR03", 2025, [{ account: "2493", saldo: -2_000_000 }], 1_000_000, angaben);
  const markup = renderToStaticMarkup(
    createElement(KapgSteuern, { year: 2025, data: { angaben, gespeichert: true, angehobenVon: null, steuern }, closed: true }),
  );
  expect(markup).toContain(`Negative Hinzurechnung nach § 8 Nr. 1 GewStG</th><td class="num">${formatEuro(-500_000)}</td>`);
  const gewerbeertrag = markup.match(/Gewerbeertrag, auf volle 100 € abgerundet<\/th><td[^>]*>([^<]+)/)?.[1];
  expect(gewerbeertrag).toBe(formatEuro(500_000));
});
