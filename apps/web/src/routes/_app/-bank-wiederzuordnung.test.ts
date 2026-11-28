import { describe, expect, it } from "vitest";
import { buchungstag } from "./-bank-wiederzuordnung.tsx";

/*
 * Der Buchungsvorschlag nennt das Konto des Buchungsjahres (#2043). Eine Wiederzuordnung bucht der Server am Tag der
 * Aufhebung, nicht am Tag des Umsatzes (bookPart, reassignmentSource): Der Vorschlag muss dasselbe Jahr nehmen.
 */
describe("Buchungstag einer neuen Zuordnung", () => {
  const umsatz = "2024-12-02";
  // Je Vorzeichen eine Aufhebung: Ohne Wahl nimmt der Server sie
  const eindeutig = [
    { id: "a", date: "2026-03-10", remaining: 10_000 },
    { id: "c", date: "2025-06-30", remaining: -2_000 },
  ];
  // Zwei Aufhebungen mit demselben Vorzeichen: Der Server verlangt die Wahl
  const mehrere = [...eindeutig, { id: "b", date: "2026-11-28", remaining: 5_000 }];

  it("ohne aufgehobene Zuordnung der Tag des Umsatzes", () => {
    expect(buchungstag([], 10_000, undefined, umsatz)).toBe(umsatz);
  });

  it("ohne Wahl der Tag der einen Aufhebung mit demselben Vorzeichen, wie der Server sie nimmt", () => {
    expect(buchungstag(eindeutig, 10_000, undefined, umsatz)).toBe("2026-03-10");
    expect(buchungstag(eindeutig, -2_000, undefined, umsatz)).toBe("2025-06-30");
  });

  it("mit gewählter Aufhebung deren Tag", () => {
    expect(buchungstag(mehrere, 5_000, "b", umsatz)).toBe("2026-11-28");
    expect(buchungstag(mehrere, 5_000, "a", umsatz)).toBe("2026-03-10");
  });

  it("als neuer Betrag neben den aufgehobenen der Tag des Umsatzes", () => {
    expect(buchungstag(mehrere, 10_000, "neu", umsatz)).toBe(umsatz);
  });
});
