import { describe, expect, it } from "vitest";
import { ausgelassenText } from "./ausgelassen-text.ts";

const keine = { drafts: 0, quotations: 0, orderConfirmations: 0, deliveryNotes: 0, other: 0 };

describe("Satz über ausgelassene Vorgänge in Schritt 2", () => {
  it("nennt je Art die Zahl aus der Sicherung, in Einzahl und Mehrzahl", () => {
    const webOmitted = { drafts: 1, quotations: 2, orderConfirmations: 1, deliveryNotes: 0, other: 1 };
    expect(ausgelassenText({ webOmitted })).toBe("Die Sicherung lässt 1 Entwurf, 2 Angebote, 1 Auftragsbestätigung, 1 sonstigen Vorgang aus.");
    expect(ausgelassenText({ webOmitted: { ...keine, orderConfirmations: 3, deliveryNotes: 2, other: 4 } })).toBe(
      "Die Sicherung lässt 3 Auftragsbestätigungen, 2 Lieferscheine, 4 sonstige Vorgänge aus.",
    );
  });

  it("sagt ausdrücklich, dass die Sicherung nichts auslässt", () => {
    expect(ausgelassenText({ webOmitted: keine })).toBe("Die Sicherung lässt keine Vorgänge aus.");
  });

  it("nennt ohne Zahlen der Sicherung nur die übergangenen Entwürfe des Abrufs", () => {
    expect(ausgelassenText({ ignored: { drafts: 1 } })).toBe("Übergangen, kein Beleg: 1 Entwurf");
    expect(ausgelassenText({ ignored: { drafts: 3 } })).toBe("Übergangen, kein Beleg: 3 Entwürfe");
    expect(ausgelassenText({ ignored: { drafts: 0 } })).toBeNull();
    expect(ausgelassenText({})).toBeNull();
  });
});
