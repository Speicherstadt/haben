import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DURCHLAEUFE, HAUPTPROJEKTE, projekteFuerTeil, TEILE } from "../../e2e/durchlaeufe.ts";

// Feste Verteilung der Ende-zu-Ende-Tests auf die Teile der CI (#1742)
describe("TEILE", () => {
  const zugeordnet: string[] = Object.values(TEILE).flat();

  it("ordnet jedes Projekt genau einem Teil zu", () => {
    const alle = [...HAUPTPROJEKTE, ...Object.keys(DURCHLAEUFE)];
    expect([...zugeordnet].sort()).toEqual(alle.sort());
  });

  it("legt „mit-daten“ in den Teil von „ablauf“, von dem es abhängt", () => {
    const teil = Object.values(TEILE).find((projekte) => (projekte as readonly string[]).includes("mit-daten"));
    expect(teil).toContain("ablauf");
  });

  it("deckt sich mit der Matrix in ci.yml", () => {
    const ci = readFileSync(new URL("../../../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const job = ci.slice(ci.indexOf("\n  e2e-teil:"));
    const zeile = job.match(/^\s+teil: \[(.*)\]$/m)?.[1] ?? "";
    const matrix = zeile.split(",").map((teil) => teil.trim());
    expect(matrix).toEqual([...Object.keys(TEILE), "sso"]);
  });

  it("liest E2E_TEIL: ohne Angabe alle, unbekannt bricht ab", () => {
    expect(projekteFuerTeil("")).toBeUndefined();
    expect(projekteFuerTeil("rechnungen")).toEqual(["rechnungen"]);
    expect(() => projekteFuerTeil("gibt-es-nicht")).toThrow("unbekannt");
  });
});
