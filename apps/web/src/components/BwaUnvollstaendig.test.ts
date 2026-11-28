import type { UnvollstaendigHinweis } from "@haben/core";
import { describe, expect, it } from "vitest";
import { ziel } from "./BwaUnvollstaendig.tsx";

/* Wohin die Hinweise der BWA auf Unvollständiges führen (#1635) */

const hinweis = (
  art: UnvollstaendigHinweis["art"],
  link: UnvollstaendigHinweis["link"],
  extra: Partial<UnvollstaendigHinweis> = {},
): UnvollstaendigHinweis => ({
  art,
  ton: "info",
  anzahl: 2,
  link,
  ...extra,
});

describe("ziel", () => {
  it("offene Umsätze zählen über alle Konten und führen zu allen", () => {
    expect(ziel(hinweis("ausgaben", "/bank"))).toEqual({ to: "/bank", search: { konto: "alle" } });
    expect(ziel(hinweis("eingaenge", "/bank"))).toEqual({ to: "/bank", search: { konto: "alle" } });
  });

  it("ein Konto, das zu früh aufhört, führt zu ihm, mehrere zu allen", () => {
    const visa = { id: "k1", name: "Visa", bis: "2026-03-05" };
    expect(ziel(hinweis("konto", "/bank", { konten: [visa] }))).toEqual({ to: "/bank", search: { konto: "k1" } });
    expect(ziel(hinweis("konto", "/bank", { konten: [visa, { ...visa, id: "k2" }] }))).toEqual({ to: "/bank", search: { konto: "alle" } });
  });

  it("Belege führen zu denen „Zu prüfen“, Entwürfe zu den Rechnungen", () => {
    expect(ziel(hinweis("belege", "/belege"))).toEqual({ to: "/belege", search: { status: "pruefen" } });
    expect(ziel(hinweis("rechnungsentwuerfe", "/rechnungen"))).toEqual({ to: "/rechnungen", search: undefined });
  });
});
