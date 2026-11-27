import { describe, expect, it } from "vitest";
import { directBookingText } from "./direktbuchung.ts";

describe("Buchungstext einer Buchung ohne Beleg", () => {
  it("Gegenseite · Kurzform der Art; ohne Gegenseite „Bankumsatz“", () => {
    expect(directBookingText("ustVorauszahlung", "einzelunternehmen", "Finanzamt Regensburg")).toBe("Finanzamt Regensburg · USt-Vorauszahlung");
    expect(directBookingText("gebuehren", "einzelunternehmen", "")).toBe("Bankumsatz · Bankgebühren");
  });

  it("„privat“ ist in GmbH und UG das Gesellschafter-Verrechnungskonto", () => {
    expect(directBookingText("privat", "einzelunternehmen", "Mia Muster")).toBe("Mia Muster · Privat");
    expect(directBookingText("privat", "gmbh", "Max Muster")).toBe("Max Muster · Gesellschafter (Verrechnungskonto)");
    expect(directBookingText("privat", "ug", "")).toBe("Bankumsatz · Gesellschafter (Verrechnungskonto)");
    expect(directBookingText("geldtransit", "ug", "Steuerkonto")).toBe("Steuerkonto · Geldtransit");
  });
});
