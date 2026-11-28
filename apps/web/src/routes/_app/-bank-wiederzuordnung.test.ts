import { describe, expect, it } from "vitest";
import { buchungstag } from "./-bank-wiederzuordnung.tsx";

/*
 * Der Buchungsvorschlag nennt das Konto des Buchungsjahres (#2043). Eine Wiederzuordnung bucht der Server am Tag der
 * Aufhebung, nicht am Tag des Umsatzes (bookPart, reassignmentSource): Der Vorschlag muss dasselbe Jahr nehmen.
 */
describe("Buchungstag einer neuen Zuordnung", () => {
  const umsatz = "2024-12-02";
  const quellen = [
    { id: "a", date: "2026-03-10", remaining: 10_000 },
    { id: "b", date: "2026-11-28", remaining: 5_000 },
    { id: "c", date: "2025-06-30", remaining: -2_000 },
  ];

  it("ohne aufgehobene Zuordnung der Tag des Umsatzes", () => {
    expect(buchungstag([], 10_000, undefined, umsatz)).toBe(umsatz);
  });

  it("mit gewählter Aufhebung deren Tag", () => {
    expect(buchungstag(quellen, 5_000, "b", umsatz)).toBe("2026-11-28");
  });

  it("ohne Wahl der Tag der ersten Aufhebung mit demselben Vorzeichen, wie der Server sie nimmt", () => {
    expect(buchungstag(quellen, 10_000, undefined, umsatz)).toBe("2026-03-10");
    expect(buchungstag(quellen, -2_000, undefined, umsatz)).toBe("2025-06-30");
  });

  it("als neuer Betrag neben den aufgehobenen der Tag des Umsatzes", () => {
    expect(buchungstag(quellen, 10_000, "neu", umsatz)).toBe(umsatz);
  });
});
