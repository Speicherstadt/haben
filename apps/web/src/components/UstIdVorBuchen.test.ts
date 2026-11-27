import { describe, expect, it, vi } from "vitest";

vi.mock("../server/functions/ustid-bestaetigung.ts", () => ({ ustIdVorBuchenFn: {}, ustIdVorFestschreibenFn: {} }));
const { hinweisNachsatz, ustIdVorBuchenNoetig } = await import("./UstIdVorFestschreiben.tsx");

describe("USt-IdNr. des Lieferanten vor dem Buchen (#1490)", () => {
  it("prüft nur beim innergemeinschaftlichen Erwerb und bei § 13b für eine EU-Leistung", () => {
    expect(ustIdVorBuchenNoetig("ig_erwerb")).toBe(true);
    expect(ustIdVorBuchenNoetig("eu")).toBe(true);
    expect(ustIdVorBuchenNoetig("drittland")).toBe(false);
    expect(ustIdVorBuchenNoetig(null)).toBe(false);
  });
});

describe("Nachsatz zum Hinweis vor dem Festschreiben", () => {
  it("verspricht kein „geht trotzdem“, wenn die Nummer das Festschreiben sperrt", () => {
    expect(hinweisNachsatz(true, "Festschreiben geht trotzdem")).toBe("Festschreiben geht erst, wenn die USt-IdNr. am Kontakt stimmt");
    expect(hinweisNachsatz(undefined, "Festschreiben geht trotzdem")).toBe("Festschreiben geht trotzdem");
  });
});
