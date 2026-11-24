import type { BasisPoints } from "@haben/core";
import { describe, expect, it } from "vitest";
import { vorschlagHinweis } from "./kapg-vorschlag.ts";

describe("Hinweis zum Vorschlag aus dem Vorjahr (#1310)", () => {
  it("nennt die Anhebung auf den Mindesthebesatz mit beiden Werten", () => {
    expect(vorschlagHinweis(2027, 280, 250)).toBe(
      "Vorgeschlagen aus 2026: Hebesatz und die Verlustvorträge nach der Rechnung des Vorjahres; den Hebesatz von 250 % hat Haben auf den Mindesthebesatz von 280 % angehoben (§ 16 Abs. 4 Satz 2 GewStG). Bitte mit dem Bescheid abgleichen und speichern.",
    );
  });

  it("bleibt ohne Anhebung, wie er war", () => {
    expect(vorschlagHinweis(2027, 400, null)).toBe(
      "Vorgeschlagen aus 2026: Hebesatz und die Verlustvorträge nach der Rechnung des Vorjahres. Bitte mit dem Bescheid abgleichen und speichern.",
    );
  });

  it("nimmt Hebesätze nur in ganzen Prozent (geprüft im Typecheck, #1132)", () => {
    const satzInBasispunkten: BasisPoints = 25_000;
    // @ts-expect-error Basispunkte sind keine ganzen Prozent
    expect(vorschlagHinweis(2027, 280, satzInBasispunkten)).toContain("25000 %");
  });
});
