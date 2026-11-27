import { describe, expect, it } from "vitest";
import { kontoWaehlen, vorhandeneKonten } from "./-bank-einrichtung-konto.ts";

describe("Einrichtung mit Datei: Konto in Haben (#2008)", () => {
  const daten = {
    alleKonten: [
      { id: "k1", provider: "stripe", name: "Shop DE", marketplace: null },
      { id: "k2", provider: "stripe", name: "Stripe CSV", marketplace: null },
      { id: "k3", provider: "amazon", name: "Amazon.de", marketplace: "Amazon.de" },
    ],
    verbindungen: [{ provider: "stripe", name: "Shop DE", bankAccountId: "k1" }],
    abgerufeneKonten: [],
  } as unknown as Parameters<typeof vorhandeneKonten>[0];

  it("bietet kein Konto an, das Haben über die API abruft (#1988)", () => {
    expect(vorhandeneKonten(daten, "stripe").map((k) => k.name)).toEqual(["Stripe CSV"]);
    expect(vorhandeneKonten(daten, "amazon").map((k) => k.name)).toEqual(["Amazon.de"]);
  });

  it("ein gewähltes Konto bringt seinen Namen mit, „Neues Konto“ den Vorschlag", () => {
    const start = { name: "Stripe", marketplace: "", kontoId: null };
    expect(kontoWaehlen(start, vorhandeneKonten(daten, "stripe"), "k2", "Stripe")).toEqual({ name: "Stripe CSV", marketplace: "", kontoId: "k2" });
    expect(kontoWaehlen({ name: "Stripe CSV", marketplace: "", kontoId: "k2" }, [], "", "Stripe")).toEqual({ name: "Stripe", marketplace: "", kontoId: null });
  });
});
