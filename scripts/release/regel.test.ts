import { describe, expect, it } from "vitest";
import { art, hinweis, hinweise } from "./regel.ts";

describe("hinweis", () => {
  it("nimmt den Abschnitt bis zur nächsten Überschrift, zu 🤖, --- oder Co-authored-by", () => {
    expect(hinweis("Text\n\n## Für das Release\n\nImport neu starten.\n\n## Geprüft\n- x")).toBe("Import neu starten.");
    expect(hinweis("## Für das Release\nA\n🤖 Generated with")).toBe("A");
    expect(hinweis("## Für das Release\nA\n---------\nCo-authored-by: x")).toBe("A");
    expect(hinweis("## Für das Release\nA\nCO-AUTHORED-BY: x")).toBe("A");
    expect(hinweis("Ohne Abschnitt")).toBeNull();
  });
});

describe("hinweise", () => {
  it("je Pull Request mit Hinweis eine Überschrift", () => {
    const text = hinweise([
      { titel: "Bank: x (#1)", text: "## Für das Release\nNeu verbinden." },
      { titel: "Belege: y (#2)", text: "Nichts" },
    ]);
    expect(text).toBe("### Bank: x (#1)\nNeu verbinden.\n");
  });
});

describe("art", () => {
  it("laufender RC: prerelease oder patch", () => {
    expect(art("v0.12.0-rc.1", ["apps/web/drizzle/0400_x.sql"]).vorschlag).toBe("prerelease oder patch");
  });

  it("Migration, ELSTER oder GoBD-Kern: erst ein RC", () => {
    for (const datei of ["apps/web/drizzle/0400_x.sql", "packages/elster/src/xml.ts", "packages/gobd-kern/src/kette.ts"]) {
      expect(art("v0.12.0", [datei]).vorschlag).toBe("preminor oder prepatch");
    }
    expect(art("v0.12.0", ["apps/web/drizzle/meta/_journal.json"]).vorschlag).toBe("minor oder patch");
  });

  it("sonst minor oder patch", () => {
    expect(art("v0.12.0", ["apps/web/src/routes/bank.tsx"]).vorschlag).toBe("minor oder patch");
  });
});
