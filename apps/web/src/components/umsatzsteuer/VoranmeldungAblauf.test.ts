import { formatEuro } from "@haben/core";
import { describe, expect, it } from "vitest";
import { ablaufSchritt, ergebnisSatz } from "./VoranmeldungAblauf.tsx";

describe("Ergebnissatz der Voranmeldung (#1253, Punkt 43)", () => {
  it("nennt bei Zahllast Betrag und Frist", () => {
    expect(ergebnisSatz(123_400, "2026-12-10")).toBe(`Du zahlst ${formatEuro(123_400)} bis 10.12.2026.`);
  });

  it("nennt bei Erstattung den Betrag ohne Vorzeichen und keine Frist", () => {
    expect(ergebnisSatz(-12_300, "2026-12-10")).toBe(`Du bekommst ${formatEuro(12_300)} zurück, sobald das Finanzamt zustimmt.`);
  });

  it("sagt bei 0, dass nichts zu zahlen ist", () => {
    expect(ergebnisSatz(0, "2026-12-10")).toBe("Diesmal ist nichts zu zahlen.");
  });
});

describe("Ablauf der Voranmeldung (#1253, Punkt 42)", () => {
  const stand = { locked: false, gespeichert: true, geaendert: false, ausgeglichen: false };

  it("beginnt mit dem Prüfen der Zahlen, solange nichts gespeichert oder seit dem Speichern geändert ist", () => {
    expect(ablaufSchritt({ ...stand, gespeichert: false })).toBe(1);
    expect(ablaufSchritt({ ...stand, geaendert: true })).toBe(1);
  });

  it("geht mit dem gespeicherten, unveränderten Entwurf zum Abgeben", () => {
    expect(ablaufSchritt(stand)).toBe(2);
  });

  it("steht nach dem Festschreiben beim Zahlen, bis die Posten ausgeglichen sind; danach ist nichts mehr offen", () => {
    expect(ablaufSchritt({ ...stand, locked: true })).toBe(3);
    expect(ablaufSchritt({ ...stand, locked: true, ausgeglichen: true })).toBeNull();
  });
});
