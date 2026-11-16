import { describe, expect, it } from "vitest";
import { treatmentIssues } from "./treatment.ts";

describe("Sondergebiete im Umsatzsteuerrecht", () => {
  it.each([
    ["DE", "27498", "Helgoland"],
    ["DE", "78266", "Büsingen"],
    ["ES", "35001", "Kanarische Inseln"],
    ["ES", "38001", "Kanarische Inseln"],
    ["ES", "51001", "Ceuta"],
    ["ES", "52001", "Melilla"],
    ["IT", "23041", "Livigno"],
    ["IT", "22061", "Campione d’Italia"],
    ["GR", "63086", "Berg Athos"],
    ["GR", "63087", "Berg Athos"],
  ])("erlaubt eine ausdrücklich gewählte Ausfuhr nach %s %s (%s)", (buyerCountry, buyerPostalCode) => {
    const destination = { buyerCountry, buyerPostalCode };
    expect(treatmentIssues("ausfuhr", { rates: [0], sellerUstId: "DE123456789", ...destination })).toEqual([]);
  });

  it("behandelt eine ausdrücklich gewählte Drittlandleistung nach Helgoland nicht pauschal als Inland", () => {
    const destination = { buyerCountry: "DE", buyerPostalCode: "27498" };
    expect(treatmentIssues("drittland", { rates: [0], ...destination })).toEqual([]);
  });
});
