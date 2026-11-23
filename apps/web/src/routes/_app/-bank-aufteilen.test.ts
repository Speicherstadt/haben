import { describe, expect, it } from "vitest";
import { type SplitRow, teilFehler } from "./-bank-aufteilen.tsx";

const zeile = (key: number, amount: string) => ({ key, target: "privat", amount }) as SplitRow;

describe("Fehler am Betrag der letzten Zeile einer Aufteilung (Review #970)", () => {
  it.each([
    // Umsatz -43,00 €, verteilt -40,00 € und -6,00 €: 3,00 € zu viel
    [-4300, [-4000, -600], "Zusammen sind 3,00 € zu viel verteilt."],
    [-4300, [-4000, -200], "Zusammen fehlen noch -1,00 €."],
    [4300, [4000, 600], "Zusammen sind 3,00 € zu viel verteilt."],
    [4300, [4000, 200], "Zusammen fehlen noch 1,00 €."],
    [-4300, [-4000, -300], null],
  ])("Umsatz %i, Teile %j: %s", (open, teile, fehler) => {
    const rows = teile.map((t, i) => zeile(i + 1, String(t)));
    const rest = open - teile.reduce((s, t) => s + t, 0);
    const errors = teilFehler(rows, teile, rest, open);
    expect(errors["betrag-1"]).toBeNull();
    expect(errors["betrag-2"]).toBe(fehler);
  });
});
