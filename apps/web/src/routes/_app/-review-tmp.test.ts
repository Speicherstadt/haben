import { describe, expect, it } from "vitest";
import { anbieterWahl } from "./-bank-verbinden.tsx";

describe("Review #2011", () => {
  it("ein Stripe-Konto nur mit Datei (ohne Verbindung) heißt in der Auswahl nicht „verbunden“", () => {
    const wahl = anbieterWahl({
      anbieter: [{ provider: "stripe", name: "Stripe", felder: [{ label: "API-Schlüssel", art: "geheim" }], schritte: ["zugang", "einstellungen", "abruf"] }],
      verbindungen: [],
      alleKonten: [{ provider: "stripe", name: "Stripe CSV" }],
    } as unknown as Parameters<typeof anbieterWahl>[0]);
    expect(wahl[0]?.hint).not.toContain("verbunden: „Stripe CSV“");
  });
});
