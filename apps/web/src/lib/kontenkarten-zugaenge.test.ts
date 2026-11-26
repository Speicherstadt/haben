import { describe, expect, it } from "vitest";
import { anbieterZugaenge } from "./kontenkarten-zugaenge.ts";

/* Ablauf eines Zugangs zum Zahlungsdienstleister in der Kartenleiste (#1951): dieselbe Frist wie bei Enable Banking */
const JETZT = new Date("2026-11-26T12:00:00Z");
const uebersicht = (zugangGueltigBis: Date | null) =>
  ({
    anbieter: [{ provider: "stripe", name: "Stripe" }],
    verbindungen: [{ provider: "stripe", bankAccountId: "k1", lastSyncAt: null, lastError: null, zugangGueltigBis }],
  }) as unknown as Parameters<typeof anbieterZugaenge>[0];
const tage = (n: number) => new Date(JETZT.getTime() + n * 86_400_000);

describe("Zugänge der Zahlungsdienstleister in der Kartenleiste", () => {
  it("nennt den Ablauf erst 14 Tage vorher, danach „abgelaufen“", () => {
    expect(anbieterZugaenge(uebersicht(tage(20)), JETZT, 14)[0]).toMatchObject({ weg: "Stripe", laeuftAbAm: null, abgelaufen: false });
    expect(anbieterZugaenge(uebersicht(tage(10)), JETZT, 14)[0]).toMatchObject({ laeuftAbAm: tage(10), abgelaufen: false });
    expect(anbieterZugaenge(uebersicht(tage(-1)), JETZT, 14)[0]).toMatchObject({ laeuftAbAm: null, abgelaufen: true });
    expect(anbieterZugaenge(uebersicht(null), JETZT, 14)[0]).toMatchObject({ laeuftAbAm: null, abgelaufen: false });
  });
});
