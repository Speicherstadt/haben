import { describe, expect, it } from "vitest";
import { outgoingTaxIssues } from "./outgoing-tax-policy.ts";
import { outgoingTaxClassification, outgoingTaxDetailConflict, type OutgoingTaxDetails } from "./outgoing-tax.ts";
import { treatmentIssues } from "./treatment.ts";

const atPlace = (country: string, postalCode?: string): OutgoingTaxDetails => ({
  exemption: null,
  ancillary: null,
  assetDisposal: false,
  foreignPlace: { country, noForeignVat: true, ...(postalCode === undefined ? {} : { postalCode }) },
});

describe("Ausdrücklich erfasster tatsächlicher Leistungsort im Sondergebiet", () => {
  it("lässt den bestätigten tatsächlichen Leistungsort Helgoland auch für einen Kunden in Berlin zu", () => {
    const place = atPlace("DE", "27498").foreignPlace;
    const facts = { buyerCountry: "DE", buyerPostalCode: "10115", foreignPlace: place };
    expect(treatmentIssues("drittland", { rates: [0], ...facts })).toEqual([]);
    expect(outgoingTaxIssues("drittland", atPlace("ES", "28001"), false)).not.toEqual([]);
  });

  it.each(["MC", "AT", "ES"])("öffnet die neue Drittland-Ausnahme für einen Berliner Kunden nicht beim tatsächlichen Gemeinschaftsgebiet %s", (country) => {
    expect(treatmentIssues("drittland", { rates: [0], buyerCountry: "DE", buyerPostalCode: "10115", foreignPlace: atPlace(country).foreignPlace })).not.toEqual(
      [],
    );
  });

  it.each([
    ["DE", "27498"],
    ["DE", "78266"],
    ["ES", "38001"],
    ["IT", "23041"],
    ["GR", "63086"],
  ])("erlaubt die bestätigte Drittlandleistung bei %s %s auch für KU", (country, postalCode) => {
    const details = atPlace(country, postalCode);
    expect(outgoingTaxIssues("drittland", details, true)).toEqual([]);
    expect(outgoingTaxClassification("drittland", details)).toEqual({ kind: "foreign", confirmed: true });
    expect(treatmentIssues("drittland", { rates: [0], buyerCountry: "DE", buyerPostalCode: "10115", foreignPlace: details.foreignPlace })).toEqual([]);
  });

  it.each([
    ["DE", "10115"],
    ["ES", "28001"],
    ["IT", "20121"],
    ["GR", "10557"],
    ["AT", "38001"],
  ])("gibt Festland und abweichenden Leistungsort %s %s nicht für Drittland frei", (country, postalCode) => {
    expect(outgoingTaxIssues("drittland", atPlace(country, postalCode), true)).not.toEqual([]);
  });

  it.each(["reverse_charge", "eu_sonstige"] as const)(
    "behandelt den ausdrücklichen tatsächlichen Leistungsort Monaco auch bei %s als französisches Umsatzsteuergebiet",
    (treatment) => {
      expect(outgoingTaxIssues(treatment, atPlace("MC"), true)).toEqual([]);
      expect(outgoingTaxIssues(treatment, atPlace("MC"), false)).toEqual([]);
    },
  );

  it("lehnt den ausdrücklich erfassten tatsächlichen Ort Monaco als Drittland ab, ohne gespeicherte Daten umzuschreiben", () => {
    const details = atPlace("MC");
    const before = JSON.stringify(details);
    expect(outgoingTaxIssues("drittland", details, false)).not.toEqual([]);
    expect(outgoingTaxIssues("drittland", details, true)).not.toEqual([]);
    expect(outgoingTaxClassification("drittland", details)).toEqual({ kind: "foreign", confirmed: true });
    expect(JSON.stringify(details)).toBe(before);
  });

  it("belässt die übrigen alten Leistungsortdaten ohne neue PLZ unverändert", () => {
    for (const country of ["DE", "ES", "IT", "GR", "AT", "CH"]) {
      const details = atPlace(country);
      const before = JSON.stringify(details);
      expect(outgoingTaxClassification("drittland", details)).toEqual({ kind: "foreign", confirmed: country !== "DE" });
      expect(outgoingTaxIssues("drittland", details, true).length === 0).toBe(country === "CH");
      expect(JSON.stringify(details)).toBe(before);
    }
  });

  it("erkennt zwei ausdrücklich verschiedene tatsächliche Orte trotz desselben Landes", () => {
    expect(outgoingTaxDetailConflict("drittland", atPlace("ES", "38001"), atPlace("ES", "28001"))).toBe("foreignPlace");
    expect(outgoingTaxDetailConflict("drittland", atPlace("ES", "38001"), atPlace("ES", "38001"))).toBeNull();
    expect(outgoingTaxDetailConflict("drittland", atPlace("ES", "38001"), atPlace("ES"))).toBeNull();
  });
});
