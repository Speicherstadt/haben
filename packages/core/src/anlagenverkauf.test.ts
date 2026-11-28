import { describe, expect, it } from "vitest";
import { ASSET_ACCOUNT_NAMES } from "./afa.ts";
import { ebilanzPosition } from "./ebilanz.ts";
import { computeInvoiceTotals } from "./invoice.ts";
import { euerAusZeilen, euerZuordnung } from "./journal-euer.ts";
import { fruehereKonten } from "./kontenaenderungen.ts";
import { kontoImKontenrahmen } from "./kontenrahmen-wechsel.ts";
import { manualPostingIssues } from "./manual.ts";
import { ACCOUNTS, invoicePosting, type Kontenrahmen } from "./posting.ts";
import type { TaxTreatment } from "./treatment.ts";

/*
 * Verkauf einer Anlage per Rechnung (#2022): Erlöskonto „Erlöse aus Verkäufen Sachanlagevermögen … (bei Buchgewinn)“ je
 * Steuer der Rechnung (DATEV-Kontenrahmen 2026, SKR03 8820–8829, SKR04 4844–4849) und Zeile 19 der EÜR (Anleitung zur
 * EÜR 2025, Zeile 19 „Veräußerung oder Entnahme von Anlagevermögen“).
 */

const VERKAUF: Record<Kontenrahmen, { ust19: string; ausfuhr: string; igl: string; sonstige: string; verlust: string[] }> = {
  SKR03: { ust19: "8820", ausfuhr: "8827", igl: "8828", sonstige: "8829", verlust: ["8800", "8801", "8807", "8808"] },
  SKR04: { ust19: "4845", ausfuhr: "4844", igl: "4848", sonstige: "4849", verlust: ["6884", "6885", "6888", "6889"] },
};

const satz = (rate: 1900 | 700 | 0) => computeInvoiceTotals([{ quantity: 1000, unitPrice: 40_000, taxRate: rate }]);

describe.each(["SKR03", "SKR04"] as const)("Rechnung mit „Verkauf aus dem Anlagevermögen“ (%s)", (kr) => {
  const v = VERKAUF[kr];
  const a = ACCOUNTS[kr];

  it("19 %: Erlös auf das Konto mit 19 % USt, Steuer und Schlüssel wie bisher", () => {
    expect(invoicePosting(satz(1900), kr, "soll", "regulaer", true)).toEqual([
      { account: a.forderungen, debit: 47_600, credit: 0, taxCode: null },
      { account: v.ust19, debit: 0, credit: 40_000, taxCode: "USt19" },
      { account: a.ust[1900], debit: 0, credit: 7_600, taxCode: "USt19" },
    ]);
  });

  it("Ist: Steuer auf „Umsatzsteuer nicht fällig“", () => {
    expect(invoicePosting(satz(1900), kr, "ist", "regulaer", true).map((l) => l.account)).toEqual([a.forderungen, v.ust19, a.ustNichtFaellig[1900]]);
  });

  it("7 %: Erlös auf dem Erlöskonto 7 %, denn ein Verkaufskonto mit 7 % USt gibt es bei DATEV nicht (Kz 86 aus der Automatik)", () => {
    expect(invoicePosting(satz(700), kr, "soll", "regulaer", true)).toEqual([
      { account: a.forderungen, debit: 42_800, credit: 0, taxCode: null },
      { account: a.erloese[700], debit: 0, credit: 40_000, taxCode: "USt7" },
      { account: a.ust[700], debit: 0, credit: 2_800, taxCode: "USt7" },
    ]);
  });

  it.each([
    ["ausfuhr", "ausfuhr", "Ausfuhr"],
    ["ig_lieferung", "igl", "IGL"],
    ["kleinunternehmer", "sonstige", "KU"],
  ] as const)("%s: Verkaufskonto mit Gegenstück bei DATEV, Steuerschlüssel unverändert", (treatment: TaxTreatment, konto, code) => {
    expect(invoicePosting(satz(0), kr, "soll", treatment, true)[1]).toEqual({ account: v[konto], debit: 0, credit: 40_000, taxCode: code });
  });

  // Ohne Verkaufskonto bei DATEV (8829/4849 hat keine Automatik und brächte in DATEV keine Kennzahl der Voranmeldung): das
  // Erlöskonto wie ohne Kennzeichen; Zeile 19 der EÜR kommt dann aus dem Kennzeichen der Rechnung (Herkunft „anlagenverkauf“)
  it.each([
    ["steuerfrei", "Steuerfrei"],
    ["reverse_charge", "RC"],
    ["drittland", "Drittland"],
    ["eu_sonstige", "NichtSteuerbar"],
    ["regulaer", "frei"],
  ] as const)("%s: das Erlöskonto wie ohne Kennzeichen", (treatment: TaxTreatment, code) => {
    const ohne = invoicePosting(satz(0), kr, "soll", treatment)[1]!;
    expect(invoicePosting(satz(0), kr, "soll", treatment, true)[1]).toEqual({ account: ohne.account, debit: 0, credit: 40_000, taxCode: code });
    expect(Object.values(VERKAUF[kr])).not.toContain(ohne.account);
  });

  it("19 % und 7 % in einer Rechnung: nur der Teil zu 19 % auf das Verkaufskonto", () => {
    const totals = computeInvoiceTotals([
      { quantity: 1000, unitPrice: 40_000, taxRate: 1900 },
      { quantity: 1000, unitPrice: 10_000, taxRate: 700 },
    ]);
    expect(invoicePosting(totals, kr, "ist", "regulaer", true).map((l) => l.account)).toEqual([
      a.forderungen,
      v.ust19,
      a.ustNichtFaellig[1900],
      a.erloese[700],
      a.ustNichtFaellig[700],
    ]);
  });

  it("Storno (negativ) dreht die Seiten auf demselben Konto", () => {
    const storno = computeInvoiceTotals([{ quantity: 1000, unitPrice: -40_000, taxRate: 1900 }]);
    expect(invoicePosting(storno, kr, "soll", "regulaer", true)[1]).toEqual({ account: v.ust19, debit: 40_000, credit: 0, taxCode: "USt19" });
  });

  it("ohne Kennzeichen bleibt es beim Erlöskonto", () => {
    expect(invoicePosting(satz(1900), kr, "soll", "regulaer")[1]!.account).toBe(a.erloese[1900]);
    expect(invoicePosting(satz(1900), kr, "soll", "regulaer", false)[1]!.account).toBe(a.erloese[1900]);
  });

  it("EÜR: alle Verkaufskonten in Zeile 19, bei jeder Herkunft und auch als Kleinunternehmer", () => {
    for (const konto of [v.ust19, v.ausfuhr, v.igl, v.sonstige, ...v.verlust]) {
      for (const herkunft of ["sonst", "asset", "anlage"] as const) expect(euerZuordnung(kr, konto, herkunft), `${konto} ${herkunft}`).toBe("anlagenabgang");
      expect(euerZuordnung(kr, konto, "sonst", true), konto).toBe("anlagenabgang");
    }
  });

  it("EÜR: eine Rechnung mit Kennzeichen auf dem Erlöskonto (vor #2022 gebucht) zählt in Zeile 19, die Steuer bleibt Umsatzsteuer", () => {
    const kuFrueher = fruehereKonten(kr)
      .filter((f) => f.heute === a.erloeseSonder.kleinunternehmer)
      .map((f) => f.konto);
    const erloese = [...Object.values(a.erloese), ...Object.values(a.erloeseSonder), ...kuFrueher];
    for (const konto of erloese) {
      expect(euerZuordnung(kr, konto, "anlagenverkauf"), konto).toBe("anlagenabgang");
      expect(euerZuordnung(kr, konto, "anlagenverkauf", true), konto).toBe("anlagenabgang");
    }
    expect(euerZuordnung(kr, a.ust[1900], "anlagenverkauf")).toBe("vereinnahmteUst");
    expect(euerZuordnung(kr, a.ustNichtFaellig[700], "anlagenverkauf")).toBe("vereinnahmteUst");
    // Andere Erträge bleiben, wo sie sind
    expect(euerZuordnung(kr, a.zinsertraege, "anlagenverkauf")).toBe("einnahmenSteuerfrei");
  });

  it("EÜR: der Verkaufserlös steht getrennt von der Entnahme aus dem Anlagenverzeichnis", () => {
    const lines = invoicePosting(satz(1900), kr, "soll", "regulaer", true).slice(1);
    expect(euerAusZeilen(kr, lines)).toEqual({
      zeilen: { anlagenabgang: 40_000, vereinnahmteUst: 7_600 },
      anlagenverkauf: 40_000,
      bewirtungNichtAbziehbar: 0,
      gewerbesteuerNichtAbziehbar: 0,
    });
    const alt = invoicePosting(satz(1900), kr, "soll", "regulaer").slice(1);
    expect(euerAusZeilen(kr, alt, "anlagenverkauf").anlagenverkauf).toBe(40_000);
    expect(euerAusZeilen(kr, [{ account: v.ust19, debit: 0, credit: 40_000, taxCode: "USt19" }], "asset").anlagenverkauf).toBeUndefined();
  });

  it("freie Buchungen auf den Verkaufskonten bleiben erlaubt", () => {
    for (const konto of [v.ust19, v.ausfuhr, v.igl, v.sonstige, ...v.verlust]) {
      const issues = manualPostingIssues(
        [
          { account: a.privateinlagen, debit: 10_000, credit: 0 },
          { account: konto, debit: 0, credit: 10_000 },
        ],
        kr,
        "einzelunternehmen",
      );
      expect(
        issues.filter((issue) => issue.includes(konto)),
        konto,
      ).toEqual([]);
    }
  });

  it("Kontennamen nach dem DATEV-Kontenrahmen 2026", () => {
    for (const konto of [v.ust19, v.ausfuhr, v.igl, v.sonstige, ...v.verlust])
      expect(ASSET_ACCOUNT_NAMES[kr][konto], konto).toMatch(/^Erlöse aus Verkäufen Sachanlagevermögen/);
    expect(ASSET_ACCOUNT_NAMES[kr][v.ausfuhr]).toBe("Erlöse aus Verkäufen Sachanlagevermögen steuerfrei § 4 Nr. 1a UStG (bei Buchgewinn)");
    expect(ASSET_ACCOUNT_NAMES[kr][v.igl]).toBe("Erlöse aus Verkäufen Sachanlagevermögen steuerfrei § 4 Nr. 1b UStG (bei Buchgewinn)");
  });

  it("E-Bilanz: Erlöse aus Verkäufen von sonstigen Sachanlagen, bei Buchgewinn Ertrag, bei Buchverlust Aufwand (Taxonomie 6.10)", () => {
    for (const konto of [v.ust19, v.ausfuhr, v.igl, v.sonstige])
      expect(ebilanzPosition(kr, konto, -10_000), konto).toBe("is.netIncome.regular.operatingTC.otherOpRevenue.disposFixAss.sale.tan.other");
    for (const konto of v.verlust)
      expect(ebilanzPosition(kr, konto, -10_000), konto).toBe("is.netIncome.regular.operatingTC.otherCost.disposFixAss.sale.tan.other");
  });
});

describe("Verkaufskonten beim Wechsel des Kontenrahmens", () => {
  it.each([
    ["8820", "4845"],
    ["8827", "4844"],
    ["8828", "4848"],
    ["8829", "4849"],
    ["8800", "6889"],
    ["8801", "6885"],
    ["8807", "6884"],
    ["8808", "6888"],
  ])("SKR03 %s ↔ SKR04 %s", (skr03, skr04) => {
    expect(kontoImKontenrahmen("SKR03", "SKR04", skr03)).toBe(skr04);
    expect(kontoImKontenrahmen("SKR04", "SKR03", skr04)).toBe(skr03);
  });
});
