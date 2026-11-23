import { describe, expect, it } from "vitest";
import { JAHRESGRENZE, umsatzgrenzeNahe, VORJAHRESGRENZE } from "./kleinunternehmer-umsatz.ts";

describe("Umsatzgrenzen für Kleinunternehmer", () => {
  it.each([
    [VORJAHRESGRENZE, 2_000_000],
    [JAHRESGRENZE, 8_000_000],
  ])("warnt ab 80 %% von %s Cent", (grenze, warnung) => {
    expect(umsatzgrenzeNahe(warnung - 1, grenze)).toBe(false);
    expect(umsatzgrenzeNahe(warnung, grenze)).toBe(true);
  });
});
