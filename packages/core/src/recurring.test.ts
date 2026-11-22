import { describe, expect, it } from "vitest";
import {
  addMonthsAnchored,
  dueDates,
  fillPlaceholders,
  INVOICE_INTERVAL_OPTIONS,
  invoiceDueDates,
  invoiceIntervalFromKey,
  invoiceIntervalKey,
  invoiceIntervalLabel,
  invoiceServicePeriod,
  nextInvoiceDate,
  servicePeriodFor,
  toInvoiceInterval,
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

  it("holt verpasste Termine nach, bis zum Enddatum", () => {
    expect(dueDates("2026-08-01", 1, 1, "2026-10-02", null)).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
    expect(dueDates("2026-08-01", 1, 1, "2026-10-02", "2026-09-15")).toEqual(["2026-08-01", "2026-09-01"]);
    expect(dueDates("2026-11-01", 1, 1, "2026-10-02", null)).toEqual([]);
  });
});

describe("wiederkehrende Rechnungen in Wochen (#1691)", () => {
  const woechentlich = { intervalMonths: null, intervalWeeks: 1 } as const;
  const zweiWochen = { intervalMonths: null, intervalWeeks: 2 } as const;
  const monatlich = { intervalMonths: 1, intervalWeeks: null } as const;

  it("Termine über Monats- und Jahreswechsel, ohne Ankertag", () => {
    expect(invoiceDueDates("2026-11-23", woechentlich, 23, "2026-12-14", null)).toEqual(["2026-11-23", "2026-11-30", "2026-12-07", "2026-12-14"]);
    expect(invoiceDueDates("2026-12-21", woechentlich, 21, "2027-01-11", null)).toEqual(["2026-12-21", "2026-12-28", "2027-01-04", "2027-01-11"]);
    expect(invoiceDueDates("2026-12-18", zweiWochen, 18, "2027-01-31", "2027-01-20")).toEqual(["2026-12-18", "2027-01-01", "2027-01-15"]);
    // Schaltjahr: 29. Februar liegt dazwischen
    expect(nextInvoiceDate("2028-02-26", woechentlich, 26)).toBe("2028-03-04");
    expect(nextInvoiceDate("2026-01-31", zweiWochen, 31)).toBe("2026-02-14");
  });

  it("Monate rechnen weiter am Ankertag", () => {
    expect(nextInvoiceDate("2026-01-31", monatlich, 31)).toBe("2026-02-28");
    expect(invoiceDueDates("2026-08-01", monatlich, 1, "2026-10-02", null)).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
  });

  it("Leistungszeitraum: die Wochen ab dem Termin oder davor", () => {
    expect(invoiceServicePeriod("2026-12-28", woechentlich, "laufend")).toEqual({ from: "2026-12-28", to: "2027-01-03" });
    expect(invoiceServicePeriod("2027-01-04", woechentlich, "vorher")).toEqual({ from: "2026-12-28", to: "2027-01-03" });
    expect(invoiceServicePeriod("2026-11-23", zweiWochen, "laufend")).toEqual({ from: "2026-11-23", to: "2026-12-06" });
    expect(invoiceServicePeriod("2026-11-23", zweiWochen, "keiner")).toBeNull();
    expect(invoiceServicePeriod("2026-11-03", monatlich, "laufend")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
  });

  it("{zeitraum} nennt bei Wochen die Tage", () => {
    expect(fillPlaceholders("Support {zeitraum}", { from: "2026-12-28", to: "2027-01-03" })).toBe("Support 28.12.2026 – 03.01.2027");
    expect(fillPlaceholders("{zeitraum}", { from: "2026-11-23", to: "2026-11-29" })).toBe("23.11.2026 – 29.11.2026");
    expect(fillPlaceholders("{monat} {jahr}", { from: "2026-11-23", to: "2026-11-29" })).toBe("November 2026");
    // Ohne Leistungszeitraum bleibt es der Monat des Rechnungsdatums
    expect(fillPlaceholders("{zeitraum}", { from: "2026-11-23", to: "2026-11-23" })).toBe("November 2026");
  });

  it("Bezeichnung und Spalten des Intervalls", () => {
    expect(invoiceIntervalLabel(woechentlich)).toBe("wöchentlich");
    expect(invoiceIntervalLabel(zweiWochen)).toBe("alle 2 Wochen");
    expect(invoiceIntervalLabel({ intervalMonths: 3, intervalWeeks: null })).toBe("vierteljährlich");
    expect(INVOICE_INTERVAL_OPTIONS.map((o) => o.label)).toEqual(["wöchentlich", "alle 2 Wochen", "monatlich", "vierteljährlich", "halbjährlich", "jährlich"]);
    expect(invoiceIntervalFromKey(invoiceIntervalKey(zweiWochen))).toEqual(zweiWochen);
    expect(toInvoiceInterval({ intervalMonths: 6, intervalWeeks: null })).toEqual({ intervalMonths: 6, intervalWeeks: null });
    expect(() => toInvoiceInterval({ intervalMonths: 1, intervalWeeks: 1 })).toThrow();
    expect(() => toInvoiceInterval({ intervalMonths: null, intervalWeeks: 3 })).toThrow();
  });
});
