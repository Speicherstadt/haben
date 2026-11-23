import { describe, expect, it } from "vitest";
import { pdfData } from "./pdf.ts";
import { quotePdfData, type QuoteDocument } from "./quote.ts";
import { sampleDocument } from "./samples.ts";
import type { InvoiceDocument } from "./types.ts";
import { buildEInvoice } from "./xml.ts";

/** Geschütztes Leerzeichen zwischen Betrag und Währung als normales, damit die Erwartung lesbar bleibt */
const lesbar = (text: string | null | undefined) => (text ?? "").replace(/[  ]/g, " ");

/** Die zweite Position der Beispielrechnung (Reisekosten 189,90 € netto, 19 %) als Fahrtkosten gekennzeichnet */
const mitFahrt = (doc: InvoiceDocument): InvoiceDocument => ({
  ...doc,
  lines: doc.lines.map((line) => (line.position === 2 ? { ...line, arbeitskosten: true } : line)),
});

// Satz zum Anteil der Arbeits-, Maschinen- und Fahrtkosten (§ 35a EStG, #712) unter den Summen und als BT-22
describe("Anteil der Arbeits-, Maschinen- und Fahrtkosten (#712)", () => {
  it("steht unter den Summen, brutto mit Umsatzsteuer", () => {
    expect(lesbar(pdfData(mitFahrt(sampleDocument())).taxNote)).toBe(
      "Darin sind Arbeits-, Maschinen- und Fahrtkosten von 225,98 € inkl. USt enthalten (§ 35a EStG).",
    );
  });

  it("beim Kleinunternehmer nach dessen Hinweis und ohne „inkl. USt“", () => {
    const lines = [
      { description: "Rauchwarnmelder", quantity: 3000, unit: "Stk.", unitPrice: 3100, taxRate: 0 as const },
      { description: "Montage", quantity: 3000, unit: "Stk.", unitPrice: 800, taxRate: 0 as const },
      { description: "Anfahrt", quantity: 1000, unit: "Psch.", unitPrice: 3500, taxRate: 0 as const },
    ];
    const doc = sampleDocument({ taxTreatment: "kleinunternehmer", lines });
    const note = pdfData(doc).taxNote!;
    const marked = { ...doc, lines: doc.lines.map((line) => (line.position > 1 ? { ...line, arbeitskosten: true } : line)) };
    expect(lesbar(pdfData(marked).taxNote)).toBe(`${note}\nDarin sind Arbeits-, Maschinen- und Fahrtkosten von 59,00 € enthalten (§ 35a EStG).`);
  });

  it("englisch, und in der Schlussrechnung als Anteil der ganzen Leistung", () => {
    expect(lesbar(pdfData({ ...mitFahrt(sampleDocument()), language: "en" }).taxNote)).toBe(
      "This includes labour, machinery and travel costs of €225.98 incl. VAT (§ 35a EStG).",
    );
    const schluss = mitFahrt(
      sampleDocument({
        lines: [
          { description: "Softwareentwicklung September", quantity: 152000, unit: "Std.", unitPrice: 9500, taxRate: 1900 },
          { description: "Reisekosten Hamburg", quantity: 1000, unit: "Psch.", unitPrice: 18990, taxRate: 1900 },
          { description: "Abschlag 2026-030", quantity: 1000, unit: "Psch.", unitPrice: -50_000, taxRate: 1900, deductionOf: "abschlag" },
        ],
      }),
    );
    expect(lesbar(pdfData(schluss).taxNote)).toBe(
      "In der gesamten Leistung vor Abzug der Abschlagsrechnungen sind Arbeits-, Maschinen- und Fahrtkosten von 225,98 € inkl. USt enthalten (§ 35a EStG).",
    );
  });

  describe("Schlussrechnung mit Abschlagsrechnungen, die ihren Anteil nennen (#1667)", () => {
    const schluss = (overrides: Partial<InvoiceDocument> = {}): InvoiceDocument => ({
      ...mitFahrt(
        sampleDocument({
          lines: [
            { description: "Softwareentwicklung September", quantity: 152000, unit: "Std.", unitPrice: 9500, taxRate: 1900 },
            { description: "Reisekosten Hamburg", quantity: 1000, unit: "Psch.", unitPrice: 18990, taxRate: 1900 },
            { description: "Abschlag 2026-030", quantity: 1000, unit: "Psch.", unitPrice: -50_000, taxRate: 1900, deductionOf: "abschlag" },
          ],
        }),
      ),
      deducted: [
        { number: "2026-030", issueDate: "2026-09-15", arbeitskosten: 6000 },
        { number: "2026-031", issueDate: "2026-09-30", arbeitskosten: 4000 },
      ],
      ...overrides,
    });
    const ganz =
      "In der gesamten Leistung vor Abzug der Abschlagsrechnungen sind Arbeits-, Maschinen- und Fahrtkosten von 225,98 € inkl. USt enthalten (§ 35a EStG).";

    it("nennt in PDF und BT-22, wie viel auf die Abschlagsrechnungen und wie viel auf diese Rechnung entfällt", async () => {
      const satz = `${ganz} Davon entfallen 100,00 € auf die Abschlagsrechnungen und 125,98 € auf diese Rechnung.`;
      expect(lesbar(pdfData(schluss()).taxNote)).toBe(satz);
      expect(lesbar((await buildEInvoice({ ...schluss(), format: "xrechnung-cii" })).xml)).toContain(satz);
    });

    it("englisch", () => {
      expect(lesbar(pdfData(schluss({ language: "en" })).taxNote)).toBe(
        "The total work before deducting the advance invoices includes labour, machinery and travel costs of €225.98 incl. VAT (§ 35a EStG). " +
          "Of this, €100.00 relates to the advance invoices and €125.98 to this invoice.",
      );
    });

    it("ohne Anteil auf den Abschlagsrechnungen und im Storno nur der erste Satz", () => {
      expect(lesbar(pdfData(schluss({ deducted: [{ number: "2026-030", issueDate: "2026-09-15" }] })).taxNote)).toBe(ganz);
      // Nennt eine der abgezogenen keinen Anteil, wäre die Zahl für diese Rechnung zu hoch (§ 11 Abs. 2 EStG)
      const gemischt = schluss({
        deducted: [
          { number: "2026-030", issueDate: "2026-09-15", arbeitskosten: 6000 },
          { number: "2026-032", issueDate: "2026-10-15" },
        ],
      });
      expect(lesbar(pdfData(gemischt).taxNote)).toBe(ganz);
      const storno = schluss({ kind: "storno" });
      expect(lesbar(pdfData(storno).taxNote)).not.toContain("Davon entfallen");
    });

    it("ohne zweiten Satz, wenn die Anteile der Abschläge nach Rundung über dem der ganzen Leistung liegen", () => {
      const ueber = schluss({ deducted: [{ number: "2026-030", issueDate: "2026-09-15", arbeitskosten: 22_599 }] });
      expect(lesbar(pdfData(ueber).taxNote)).toBe(ganz);
      // Genau der ganze Anteil: 0,00 € auf diese Rechnung
      const gleich = schluss({ deducted: [{ number: "2026-030", issueDate: "2026-09-15", arbeitskosten: 22_598 }] });
      expect(lesbar(pdfData(gleich).taxNote)).toBe(`${ganz} Davon entfallen 225,98 € auf die Abschlagsrechnungen und 0,00 € auf diese Rechnung.`);
    });
  });

  it("im Angebot ohne optionale Positionen", () => {
    const { seller, buyer, lines, totals } = mitFahrt(sampleDocument());
    const optional = { ...lines[1]!, position: 3, description: "Zweite Anreise", kind: "optional" as const };
    const quote: QuoteDocument = {
      number: "AN-2026-007",
      issueDate: "2026-10-01",
      validUntil: "2026-10-31",
      seller,
      buyer,
      lines: [...lines, optional],
      totals,
    };
    expect(lesbar(quotePdfData(quote).taxNote)).toBe("Darin sind Arbeits-, Maschinen- und Fahrtkosten von 225,98 € inkl. USt enthalten (§ 35a EStG).");
  });

  it("ohne Kennzeichen bleiben PDF-Daten und XML wie bisher", async () => {
    const doc = sampleDocument({ note: "Vielen Dank." });
    const off = { ...doc, lines: doc.lines.map((line) => ({ ...line, arbeitskosten: false })) };
    expect(pdfData(off)).toEqual(pdfData(doc));
    expect((await buildEInvoice({ ...off, format: "xrechnung-ubl" })).xml).toBe((await buildEInvoice({ ...doc, format: "xrechnung-ubl" })).xml);
  });

  it.each(["xrechnung-ubl", "xrechnung-cii", "zugferd"] as const)("steht bei %s als eigener BT-22 neben den Nutzereingaben", async (format) => {
    const doc = mitFahrt(sampleDocument({ format, note: "Vielen Dank." }));
    const { xml } = await buildEInvoice(doc);
    const tag = format === "xrechnung-ubl" ? "cbc:Note" : "ram:Content";
    expect(lesbar(xml)).toContain(`<${tag}>Darin sind Arbeits-, Maschinen- und Fahrtkosten von 225,98 € inkl. USt enthalten (§ 35a EStG).</${tag}>`);
    expect(xml).toContain(`<${tag}>Vielen Dank.</${tag}>`);
  });

  it("nennt den Betrag in Fremdwährung in PDF und XML in der Währung der Rechnung", async () => {
    const doc = { ...mitFahrt(sampleDocument({ format: "xrechnung-cii" })), currency: "USD" };
    expect(lesbar(pdfData(doc).taxNote)).toContain("von 225,98 USD inkl. USt");
    expect(lesbar((await buildEInvoice(doc)).xml)).toContain("von 225,98 USD inkl. USt");
  });
});
