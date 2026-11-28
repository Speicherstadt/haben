import { laenderAuswahl } from "@haben/core";
import { describe, expect, it } from "vitest";
import { landSuche } from "./LandCombobox.tsx";

/* Suche in der Länderauswahl (#914): nach deutschem Namen oder nach dem Code, ein genau getippter Code zuerst */

const auswahl = laenderAuswahl();
const suche = (text: string) => landSuche(auswahl, text).hits.map((l) => l.code);

describe("Länder suchen", () => {
  it("ein genau getippter Code steht vorn, auch wenn Namen mit denselben Buchstaben beginnen", () => {
    expect(suche("ES")[0]).toBe("ES");
    expect(suche("es").slice(0, 3)).toEqual(["ES", "EE", "SZ"]);
    expect(suche("at")[0]).toBe("AT");
    expect(suche("DE")[0]).toBe("DE");
  });

  it("findet nach dem Namen, ohne Umlaute und mitten im Wort", () => {
    expect(suche("Nieder")).toEqual(["NL", "BQ"]);
    expect(suche("osterr")).toEqual(["AT"]);
    expect(suche("Königreich")).toContain("GB");
  });

  it("ohne Eingabe alle, nach Namen sortiert", () => {
    const { hits, total } = landSuche(auswahl, "");
    expect(total).toBe(249);
    expect(hits[0]!.code).toBe("AF");
  });
});
