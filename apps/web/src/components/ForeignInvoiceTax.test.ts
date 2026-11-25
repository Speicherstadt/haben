import type { TaxTreatment } from "@haben/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { nurNetto, TaxSection, type TaxRow } from "./ForeignInvoiceTax.tsx";

const render = (treatment: TaxTreatment, rows: TaxRow[]) =>
  renderToStaticMarkup(
    createElement(TaxSection, {
      treatment,
      onTreatment: () => {},
      kleinunternehmer: treatment === "kleinunternehmer",
      exemptionReason: "",
      onExemptionReason: () => {},
      foreignPlace: null,
      onForeignPlace: () => {},
      rows,
      onRows: () => {},
    }),
  );

// Ausgangsrechnung hochladen (#1880): Ohne deutsche Umsatzsteuer gilt 0 %, einzutragen ist nur der Nettobetrag
describe("Steuer der hochgeladenen Ausgangsrechnung (#1880)", () => {
  it("fragt bei einer Behandlung ohne deutsche Umsatzsteuer nur den Nettobetrag ab", () => {
    for (const treatment of ["steuerfrei", "kleinunternehmer", "reverse_charge", "drittland", "eu_sonstige", "ig_lieferung", "ausfuhr"] as const) {
      const html = render(treatment, [{ rate: "0", net: "500,00", tax: "0,00" }]);
      expect(html).toContain("Netto (€)");
      expect(html).toContain('value="500,00"');
      expect(html).toContain("gilt 0 %");
      expect(html).not.toContain("Steuersatz");
      expect(html).not.toContain("Steuer 1 (€)");
      expect(html).not.toContain("Weiteren Steuersatz");
    }
  });

  it("regulär bleiben Steuersatz, Netto und Steuer je Zeile", () => {
    const html = render("regulaer", [{ rate: "1900", net: "100,00", tax: "19,00" }]);
    for (const text of ["Steuersatz 1", "Netto 1 (€)", "Steuer 1 (€)", "Weiteren Steuersatz"]) expect(html).toContain(text);
  });

  it("fasst beim Wechsel die Zeilen zu einer zu 0 % ohne Steuer zusammen", () => {
    expect(nurNetto([{ rate: "1900", net: "1.000,00", tax: "190,00" }])).toEqual([{ rate: "0", net: "1.000,00", tax: "0,00" }]);
    expect(
      nurNetto([
        { rate: "1900", net: "100,00", tax: "19,00" },
        { rate: "700", net: "50,50", tax: "3,54" },
      ]),
    ).toEqual([{ rate: "0", net: "150,50", tax: "0,00" }]);
    // Eine leere oder unlesbare Zeile zählt nicht mit; bleibt nichts, bleibt das Feld leer
    expect(
      nurNetto([
        { rate: "1900", net: "", tax: "" },
        { rate: "700", net: "20,00", tax: "1,40" },
      ]),
    ).toEqual([{ rate: "0", net: "20,00", tax: "0,00" }]);
    expect(nurNetto([{ rate: "1900", net: "", tax: "" }])).toEqual([{ rate: "0", net: "", tax: "0,00" }]);
  });
});
