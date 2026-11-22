import { describe, expect, it } from "vitest";
import {
  addMonthsAnchored,
  fillPlaceholders,
  recurrenceDueDates,
  invoiceServicePeriod,
  nextRecurrenceDate,
  nthRecurrenceDate,
  servicePeriodFor,
  servicePeriodModes,
} from "./recurring.ts";

describe("wiederkehrende Rechnungen", () => {
  it("Monatsende bleibt am Ankertag", () => {
    expect(addMonthsAnchored("2026-01-31", 1, 31)).toBe("2026-02-28");
    expect(addMonthsAnchored("2026-02-28", 1, 31)).toBe("2026-03-31");
    expect(addMonthsAnchored("2026-11-15", 3, 15)).toBe("2027-02-15");
    expect(addMonthsAnchored("2028-01-31", 1, 31)).toBe("2028-02-29");
  });

  it("Leistungszeitraum laufend und vergangen", () => {
    expect(servicePeriodFor("2026-11-03", 1, "laufend")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(servicePeriodFor("2026-01-03", 1, "vorher")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(servicePeriodFor("2026-11-03", 3, "laufend")).toEqual({ from: "2026-11-01", to: "2027-01-31" });
    expect(servicePeriodFor("2026-11-03", 12, "keiner")).toBeNull();
  });

  it("Platzhalter", () => {
    expect(fillPlaceholders("Wartung {monat} {jahr} ({quartal})", { from: "2026-11-01", to: "2026-11-30" })).toBe("Wartung November 2026 (Q4)");
    expect(fillPlaceholders("Hosting {zeitraum}", { from: "2026-10-01", to: "2026-12-31" })).toBe("Hosting Oktober – Dezember 2026");
    expect(fillPlaceholders("{zeitraum}", { from: "2026-11-01", to: "2027-01-31" })).toBe("November 2026 – Januar 2027");
  });
});

describe("wiederkehrende Rechnungen mit Dauer nach ISO 8601 (#1691)", () => {
  it("Termine in Wochen über Monats- und Jahreswechsel, ohne Ankertag", () => {
    expect(recurrenceDueDates("2026-11-23", "P1W", 23, "2026-12-14", null)).toEqual(["2026-11-23", "2026-11-30", "2026-12-07", "2026-12-14"]);
    expect(recurrenceDueDates("2026-12-21", "P1W", 21, "2027-01-11", null)).toEqual(["2026-12-21", "2026-12-28", "2027-01-04", "2027-01-11"]);
    expect(recurrenceDueDates("2026-12-18", "P2W", 18, "2027-01-31", "2027-01-20")).toEqual(["2026-12-18", "2027-01-01", "2027-01-15"]);
    expect(recurrenceDueDates("2026-12-14", "P4W", 14, "2027-02-28", null)).toEqual(["2026-12-14", "2027-01-11", "2027-02-08"]);
    // Schaltjahr: 29. Februar liegt dazwischen
    expect(nextRecurrenceDate("2028-02-26", "P1W", 26)).toBe("2028-03-04");
    expect(nextRecurrenceDate("2026-01-31", "P2W", 31)).toBe("2026-02-14");
  });

  it("Monate und Jahre rechnen weiter am Ankertag", () => {
    expect(nextRecurrenceDate("2026-01-31", "P1M", 31)).toBe("2026-02-28");
    expect(nextRecurrenceDate("2026-12-31", "P2M", 31)).toBe("2027-02-28");
    expect(nextRecurrenceDate("2027-02-28", "P2M", 31)).toBe("2027-04-30");
    expect(nextRecurrenceDate("2028-02-29", "P1Y", 29)).toBe("2029-02-28");
    expect(nthRecurrenceDate("2027-01-31", "P1M", 31, 2)).toBe("2027-03-31");
    expect(recurrenceDueDates("2026-08-01", "P1M", 1, "2026-10-02", null)).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
  });

  it("Leistungszeitraum: die Wochen ab dem Termin oder davor, Monate wie bisher", () => {
    expect(invoiceServicePeriod("2026-12-28", "P1W", "laufend")).toEqual({ from: "2026-12-28", to: "2027-01-03" });
    expect(invoiceServicePeriod("2027-01-04", "P1W", "vorher")).toEqual({ from: "2026-12-28", to: "2027-01-03" });
    expect(invoiceServicePeriod("2026-11-23", "P2W", "laufend")).toEqual({ from: "2026-11-23", to: "2026-12-06" });
    expect(invoiceServicePeriod("2026-12-14", "P4W", "vorher")).toEqual({ from: "2026-11-16", to: "2026-12-13" });
    expect(invoiceServicePeriod("2026-11-23", "P2W", "keiner")).toBeNull();
    expect(invoiceServicePeriod("2026-11-03", "P1M", "laufend")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(invoiceServicePeriod("2026-12-03", "P2M", "laufend")).toEqual({ from: "2026-12-01", to: "2027-01-31" });
    expect(invoiceServicePeriod("2027-01-03", "P1Y", "vorher")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("{zeitraum} nennt bei Wochen die Tage", () => {
    expect(fillPlaceholders("Support {zeitraum}", { from: "2026-12-28", to: "2027-01-03" })).toBe("Support 28.12.2026 – 03.01.2027");
    expect(fillPlaceholders("{zeitraum}", { from: "2026-11-23", to: "2026-11-29" })).toBe("23.11.2026 – 29.11.2026");
    expect(fillPlaceholders("{monat} {jahr}", { from: "2026-11-23", to: "2026-11-29" })).toBe("November 2026");
    // Ohne Leistungszeitraum bleibt es der Monat des Rechnungsdatums
    expect(fillPlaceholders("{zeitraum}", { from: "2026-11-23", to: "2026-11-23" })).toBe("November 2026");
  });

  it("Bezeichnungen des Leistungszeitraums je nach Intervall", () => {
    expect(servicePeriodModes("P1M").laufend).toBe("Laufender Zeitraum (ab dem Rechnungsmonat)");
    expect(servicePeriodModes("P4W").laufend).toBe("Laufender Zeitraum (ab dem Rechnungsdatum)");
  });
});
