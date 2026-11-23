import { describe, expect, it } from "vitest";
import { toArbeitnehmerDraft } from "./AnlageN.tsx";
import { anlageNLesen } from "./jahreserklaerung/anlage-n-pruefung.ts";

describe("Anlage N: Entwurf", () => {
  it("behält 0 Monate als Mittelpunkt des Arbeitszimmers, statt sie als ganzes Jahr zu lesen (#940)", () => {
    // 0 Monate: keine Jahrespauschale (§ 4 Abs. 5 Satz 1 Nr. 6b Satz 4 EStG); ein leeres Feld hieße ganzjährig
    const leer = toArbeitnehmerDraft(undefined);
    const bescheinigungen = leer.bescheinigungen.map((b) => ({ ...b, brutto: "42.000,00" }));
    const draft = { ...leer, aktiv: true, bescheinigungen, arbeitszimmer: "1.260,00", arbeitszimmerMonate: "0" };
    const fehler: Record<string, string | null> = {};
    const an = anlageNLesen(draft, "a", fehler);
    expect(Object.values(fehler).filter(Boolean)).toEqual([]);
    expect(an?.werbungskosten.arbeitszimmerMonate).toBe(0);
    expect(toArbeitnehmerDraft(an).arbeitszimmerMonate).toBe("0");
  });
});
