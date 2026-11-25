import { describe, expect, it } from "vitest";
import { privatanteilFaelltWeg } from "./-beleg-pruefung.ts";

describe("privatanteilFaelltWeg", () => {
  it("meldet den Anteil, der beim Aufteilen verloren geht", () => {
    expect(privatanteilFaelltWeg("25", true)).toBe(25);
    expect(privatanteilFaelltWeg("40", true)).toBe(40);
  });

  it("meldet nichts ohne Aufteilung", () => {
    expect(privatanteilFaelltWeg("25", false)).toBeNull();
  });

  it("meldet nichts, wenn kein Anteil eingetragen ist", () => {
    expect(privatanteilFaelltWeg("", true)).toBeNull();
    expect(privatanteilFaelltWeg("0", true)).toBeNull();
  });

  it("meldet nichts bei einer unlesbaren Eingabe", () => {
    expect(privatanteilFaelltWeg("abc", true)).toBeNull();
  });
});
