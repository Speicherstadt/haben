import { describe, expect, it } from "vitest";
import { LAENDER, landName, laenderAuswahl, plzProblem } from "./laender.ts";
import { EU_COUNTRIES } from "./treatment.ts";

describe("Länder nach ISO 3166-1 alpha-2 (#914)", () => {
  it("enthält alle 249 offiziellen Codes, je einmal, darunter jedes EU-Land", () => {
    expect(LAENDER).toHaveLength(249);
    expect(new Set(LAENDER).size).toBe(249);
    expect(LAENDER.every((code) => /^[A-Z]{2}$/.test(code))).toBe(true);
    for (const eu of EU_COUNTRIES) expect(LAENDER).toContain(eu);
  });

  it("nennt Länder auf Deutsch, einen unbekannten Code unverändert", () => {
    expect(landName("NL")).toBe("Niederlande");
    expect(landName("DE")).toBe("Deutschland");
    expect(landName("CH")).toBe("Schweiz");
    expect(landName("ZZ")).toBe("ZZ");
  });

  it("Auswahl nach Name sortiert; ein gespeicherter, unbekannter Code bleibt wählbar", () => {
    const auswahl = laenderAuswahl();
    expect(auswahl).toHaveLength(249);
    expect(auswahl.slice(0, 2).map((l) => l.code)).toEqual(["AF", "EG"]);
    expect(auswahl.find((l) => l.code === "NL")).toEqual({ code: "NL", name: "Niederlande" });
    expect(laenderAuswahl("QQ").find((l) => l.code === "QQ")).toEqual({ code: "QQ", name: "QQ" });
    expect(laenderAuswahl("DE")).toHaveLength(249);
  });

  it("PLZ: in Deutschland fünf Ziffern, sonst frei, leer immer erlaubt", () => {
    expect(plzProblem("DE", "93047")).toBeNull();
    expect(plzProblem("DE", "")).toBeNull();
    expect(plzProblem("DE", "9304")).toMatch(/fünf Ziffern/);
    expect(plzProblem("DE", "93047a")).toMatch(/fünf Ziffern/);
    expect(plzProblem("NL", "1015 CJ")).toBeNull();
    expect(plzProblem("GB", "SW1A 1AA")).toBeNull();
  });
});
