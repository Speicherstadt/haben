import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ABZUG_AUS, DURCHLAEUFE, HAUPTPROJEKTE, MIT_DATEN, projekteFuerTeil, TEILE } from "../../e2e/durchlaeufe.ts";

// Feste Verteilung der Ende-zu-Ende-Tests auf die Teile der CI (#1742)
describe("TEILE", () => {
  const zugeordnet: string[] = Object.values(TEILE).flat();

  it("ordnet jedes Projekt genau einem Teil zu, nur „ablauf“ und „abzug“ jedem Teil mit Daten", () => {
    const alle = [...HAUPTPROJEKTE, ...Object.keys(DURCHLAEUFE)];
    const einmal = zugeordnet.filter((projekt) => projekt !== "ablauf" && projekt !== "abzug");
    expect([...einmal].sort()).toEqual(alle.filter((projekt) => projekt !== "ablauf" && projekt !== "abzug").sort());
    expect(zugeordnet.filter((projekt) => projekt === "ablauf")).toHaveLength(MIT_DATEN.length);
    expect(zugeordnet.filter((projekt) => projekt === "abzug")).toHaveLength(MIT_DATEN.length);
  });

  it("legt jede Gruppe von „mit-daten“ in einen eigenen Teil mit „ablauf“ und „abzug“, von denen sie abhängt", () => {
    for (const gruppe of MIT_DATEN) {
      const teil = Object.values(TEILE).find((projekte) => (projekte as readonly string[]).includes(gruppe));
      expect(teil, gruppe).toContain("ablauf");
      expect(teil, gruppe).toContain("abzug");
      expect(
        teil?.filter((projekt) => (MIT_DATEN as readonly string[]).includes(projekt)),
        gruppe,
      ).toEqual([gruppe]);
    }
  });

  it("legt „ohne-daten“ nie zu „abzug“, das die Datenbank des gemeinsamen Hauptservers ersetzt", () => {
    for (const projekte of Object.values(TEILE) as readonly (readonly string[])[]) if (projekte.includes("ohne-daten")) expect(projekte).not.toContain("abzug");
  });

  it("legt jeden Abschnitt in den Teil des Durchlaufs, aus dessen Abzug er beginnt", () => {
    for (const [abschnitt, quelle] of Object.entries(ABZUG_AUS)) {
      const teil = Object.values(TEILE).find((projekte) => (projekte as readonly string[]).includes(abschnitt));
      expect(teil, abschnitt).toContain(quelle);
    }
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
    expect(projekteFuerTeil("rechnungen")).toEqual(["rechnungen", "rechnungen-kontakte", "rechnungen-artikel", "rechnungen-kasse", "rechnungen-angebote"]);
    expect(() => projekteFuerTeil("gibt-es-nicht")).toThrow("unbekannt");
  });
});
