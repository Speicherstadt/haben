import type { PaymentPlanRow } from "@haben/core";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { kleinunternehmerStand } from "../auswertungen/test-umsatz-stand.ts";

/** Text eines PDFs mit pdftotext (poppler-utils), Leerraum zusammengefasst; ohne das Werkzeug null */
function pdfText(pdf: Uint8Array): string | null {
  const dir = mkdtempSync(join(tmpdir(), "haben-35a-plan-"));
  try {
    writeFileSync(join(dir, "beleg.pdf"), pdf);
    return execFileSync("pdftotext", [join(dir, "beleg.pdf"), "-"], { encoding: "utf8" }).replace(/\s+/g, " ");
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Betrag und Währung trennt ein geschütztes Leerzeichen (formatEuro) */
const ohneNbsp = (text: string | null | undefined) => (text ?? "").replace(/[  ]/g, " ");

/*
 * Anteil der Arbeits-, Maschinen- und Fahrtkosten (§ 35a EStG) auf Abschlagsrechnungen aus dem Zahlungsplan (#1667):
 * Je Steuersatz teilt der Abschlag seinen Betrag im Verhältnis des Auftrags auf zwei Positionen auf, die Schlussrechnung
 * nennt den Anteil der ganzen Leistung und wie viel davon auf die Abschläge und auf sie selbst entfällt.
 */
describe.skipIf(!testDatabaseUrl)("§ 35a EStG auf Abschlägen aus dem Zahlungsplan (Postgres, #1667)", () => {
  let quotes: typeof import("./quotes.ts");
  let plan: typeof import("./quote-plan.ts");
  let invoices: typeof import("./index.ts");
  let contacts: typeof import("../stammdaten/contacts.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  let contactId: string;

  beforeAll(async () => {
    sql = await setupTestDb();
    quotes = await import("./quotes.ts");
    plan = await import("./quote-plan.ts");
    invoices = await import("./index.ts");
    contacts = await import("../stammdaten/contacts.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    await leeren(sql)`truncate quote_choices, quote_lines, quotes, quote_number_counters, journal_lines, journal_entries, invoice_lines, invoices,
      invoice_number_counters, contact_versions, contacts, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, ust_id, bundesland, iban, bic, bank)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'DE123456789', 'BY',
              'DE89370400440532013000', 'COBADEFFXXX', 'Commerzbank')`;
    const contact = await contacts.createContact(actor, {
      kundennummer: "",
      name: "Erika Mustermann",
      strasse: "Hafenstraße 5",
      plz: "20457",
      ort: "Hamburg",
      land: "DE",
      email: "kunde@example.com",
      ustId: "",
      iban: "",
      leitwegId: "",
      defaultFormat: null,
    });
    contactId = contact.id;
  });

  const line = (description: string, unitPrice: number, taxRate: 1900 | 700, arbeitskosten = false) => ({
    description,
    quantity: 1000,
    unit: "Psch." as const,
    unitPrice,
    taxRate,
    arbeitskosten,
  });

  /**
   * Netto: zu 19 % Fliesen 4.000 € und Verlegen 6.000 € (Arbeit), zu 7 % Material 1.000 € und Arbeit 1.000 €, 10 %
   * Gesamtrabatt. Nach Rabatt je Satz 9.000 € mit 5.400 € Arbeit und 1.800 € mit 900 € Arbeit. Plan 30 % und Rest.
   */
  const angebot = async (overrides: Record<string, unknown> = {}) =>
    quotes.finalizeQuote(
      actor,
      (
        await quotes.createQuoteDraft(actor, {
          contactId,
          issueDate: "2026-10-01",
          validUntil: "2026-10-31",
          serviceFrom: null,
          serviceTo: null,
          note: "",
          lines: [
            line("Fliesen", 400_000, 1900),
            line("Verlegen", 600_000, 1900, true),
            line("Pflanzen", 100_000, 700),
            line("Pflanzarbeiten", 100_000, 700, true),
          ],
          discount: { kind: "prozent", value: 1000 },
          paymentPlan: [
            { label: "Anzahlung", share: { kind: "prozent", value: 3000 }, due: "Auftragserteilung" },
            { label: "Schlussrechnung", share: { kind: "rest" }, due: "Abnahme" },
          ] as PaymentPlanRow[],
          ...overrides,
        } as never)
      ).id,
    );

  const positionen = async (invoiceId: string) =>
    (await sql`select description, unit_price, tax_rate, arbeitskosten from invoice_lines where invoice_id = ${invoiceId} order by position`).map((l) => [
      ohneNbsp(l.description),
      l.unit_price,
      l.tax_rate,
      l.arbeitskosten,
    ]);

  const text = "1. Anzahlung 30 % gemäß Angebot AN-2026-001 vom 01.10.2026";

  it("Abschlag teilt je Steuersatz auf, die Schlussrechnung nennt Abschläge und Rest; zusammen der Anteil der ganzen Leistung", async () => {
    const quote = await angebot();
    const abschlag = await plan.abschlagFromPlan(actor, quote.id, "2026-10-10", 0, null);
    // 30 % je Satz: 2.700 € (Arbeit 2.700 × 5.400 / 9.000 = 1.620 €) und 540 € (Arbeit 540 × 900 / 1.800 = 270 €)
    expect(await positionen(abschlag.id)).toEqual([
      [`${text}, Anteil Arbeits-, Maschinen- und Fahrtkosten`, 162_000, 1900, true],
      [`${text}, Anteil Material und Sonstiges`, 108_000, 1900, false],
      [`${text}, Anteil Arbeits-, Maschinen- und Fahrtkosten`, 27_000, 700, true],
      [`${text}, Anteil Material und Sonstiges`, 27_000, 700, false],
    ]);
    // Summen wie ohne Aufteilung: 30 % von 10.800 € netto
    expect(abschlag).toMatchObject({ net: 324_000 });

    // 1.620 € + 19 % = 1.927,80 €, 270 € + 7 % = 288,90 €
    const abschlagSatz = "Darin sind Arbeits-, Maschinen- und Fahrtkosten von 2.216,70 € inkl. USt enthalten (§ 35a EStG).";
    const fest = await invoices.finalizeInvoice(actor, abschlag.id, kleinunternehmerStand);
    expect(ohneNbsp(fest.xml)).toContain(abschlagSatz);
    const abschlagPdf = pdfText(fest.pdf!);
    if (abschlagPdf !== null) expect(ohneNbsp(abschlagPdf)).toContain(abschlagSatz);

    // Ganze Leistung: 5.400 € + 19 % = 6.426,00 €, 900 € + 7 % = 963,00 €; davon 2.216,70 € auf den Abschlag, 5.172,30 € Rest
    const schlussSatz =
      "In der gesamten Leistung vor Abzug der Abschlagsrechnungen sind Arbeits-, Maschinen- und Fahrtkosten von 7.389,00 € inkl. USt " +
      "enthalten (§ 35a EStG). Davon entfallen 2.216,70 € auf die Abschlagsrechnungen und 5.172,30 € auf diese Rechnung.";
    const schluss = await quotes.quoteToInvoice(actor, quote.id, "2026-12-01", "schluss");
    const schlussFest = await invoices.finalizeInvoice(actor, schluss.id, kleinunternehmerStand);
    expect(ohneNbsp(schlussFest.xml)).toContain(schlussSatz);
    const schlussPdf = pdfText(schlussFest.pdf!);
    if (schlussPdf !== null) expect(ohneNbsp(schlussPdf)).toContain(schlussSatz);

    // Das Storno der Schlussrechnung nennt nur den Anteil der ganzen Leistung mit Minus
    const storno = await invoices.cancelInvoice(actor, schlussFest.id, "2026-12-02");
    expect(ohneNbsp(storno.xml)).toMatch(/Arbeits-, Maschinen- und Fahrtkosten von [-−]7\.389,00 € inkl\. USt enthalten \(§ 35a EStG\)\./);
    expect(ohneNbsp(storno.xml)).not.toContain("Davon entfallen");
  }, 60_000);

  it("die Vorschau im Editor nennt in der Schlussrechnung den Anteil der Abschläge wie das PDF", async () => {
    const preview = await import("./document-preview.ts");
    const quote = await angebot();
    const abschlag = await plan.abschlagFromPlan(actor, quote.id, "2026-10-10", 0, null);
    await invoices.finalizeInvoice(actor, abschlag.id, kleinunternehmerStand);
    const schluss = (await invoices.getInvoice((await quotes.quoteToInvoice(actor, quote.id, "2026-12-01", "schluss")).id))!;
    const input = preview.documentPreviewSchema.parse({
      kind: "rechnung",
      number: "",
      issueDate: "2026-12-01",
      dueDate: "2026-12-15",
      validUntil: null,
      serviceFrom: null,
      serviceTo: null,
      paymentTermDays: 14,
      contactId,
      buyerOrderReference: "",
      sellerOrderReference: "",
      despatchAdviceReference: "",
      lines: schluss.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unitPrice: l.unitPrice,
        taxRate: l.taxRate,
        arbeitskosten: l.arbeitskosten,
        ...(l.deductionOf ? { deductionOf: l.deductionOf } : {}),
      })),
      discount: { kind: "prozent", value: 1000 },
      plan: [],
      intro: "",
      note: "",
      taxTreatment: "regulaer",
      exemptionReason: "",
      priceMode: "netto",
      language: "de",
      variant: "schluss",
      corrects: null,
      currency: "EUR",
      skonto: [],
      sepaMandateId: null,
      design: {},
    });
    const result = await preview.documentPreview(input);
    const blatt = ohneNbsp(result.text.flatMap((part) => part.lines).join(" ")).replace(/\s+/g, " ");
    expect(blatt).toContain("Davon entfallen 2.216,70 € auf die Abschlagsrechnungen und 5.172,30 € auf diese Rechnung.");
  }, 60_000);

  it("Plan 50 % / 50 % / Rest: kein negativer Anteil für die Schlussrechnung (Review #1696)", async () => {
    const quote = await angebot({
      discount: null,
      lines: [line("Verlegen", 105_100, 1900, true)],
      paymentPlan: [
        { label: "Anzahlung", share: { kind: "prozent", value: 5000 }, due: "Auftragserteilung" },
        { label: "Zwischen", share: { kind: "prozent", value: 5000 }, due: "Rohbau" },
        { label: "Schlussrechnung", share: { kind: "rest" }, due: "Abnahme" },
      ] as PaymentPlanRow[],
    });
    // Je Abschlag 525,50 € + 99,85 € (99,845 € aufgerundet) = 625,35 €; ganze Leistung 1.051,00 € + 199,69 € = 1.250,69 €
    for (const row of [0, 1]) {
      await invoices.finalizeInvoice(actor, (await plan.abschlagFromPlan(actor, quote.id, "2026-10-10", row, null)).id, kleinunternehmerStand);
    }
    const schluss = await quotes.quoteToInvoice(actor, quote.id, "2026-12-01", "schluss");
    const fest = await invoices.finalizeInvoice(actor, schluss.id, kleinunternehmerStand);
    expect(ohneNbsp(fest.xml)).toContain(
      "In der gesamten Leistung vor Abzug der Abschlagsrechnungen sind Arbeits-, Maschinen- und Fahrtkosten von 1.250,69 € inkl. USt enthalten (§ 35a EStG).",
    );
    expect(ohneNbsp(fest.xml)).not.toContain("Davon entfallen");
  }, 60_000);

  it("ein Abschlag ohne Anteil: die Schlussrechnung nennt nur die ganze Leistung (Nachtrag Review #1696)", async () => {
    const quote = await angebot({
      paymentPlan: [
        { label: "Anzahlung", share: { kind: "prozent", value: 3000 }, due: "Auftragserteilung" },
        { label: "Zwischen", share: { kind: "prozent", value: 3000 }, due: "Rohbau" },
        { label: "Schlussrechnung", share: { kind: "rest" }, due: "Abnahme" },
      ] as PaymentPlanRow[],
    });
    const erster = await plan.abschlagFromPlan(actor, quote.id, "2026-10-10", 0, null);
    await invoices.finalizeInvoice(actor, erster.id, kleinunternehmerStand);
    // Im Entwurf des zweiten nimmt jemand das Kennzeichen heraus: er nennt keinen Anteil
    const zweiter = await plan.abschlagFromPlan(actor, quote.id, "2026-10-20", 1, null);
    await sql`update invoice_lines set arbeitskosten = false where invoice_id = ${zweiter.id}`;
    const zweiterFest = await invoices.finalizeInvoice(actor, zweiter.id, kleinunternehmerStand);
    expect(ohneNbsp(zweiterFest.xml)).not.toContain("§ 35a EStG");
    const schluss = await quotes.quoteToInvoice(actor, quote.id, "2026-12-01", "schluss");
    const fest = await invoices.finalizeInvoice(actor, schluss.id, kleinunternehmerStand);
    expect(ohneNbsp(fest.xml)).toContain(
      "In der gesamten Leistung vor Abzug der Abschlagsrechnungen sind Arbeits-, Maschinen- und Fahrtkosten von 7.389,00 € inkl. USt enthalten (§ 35a EStG).",
    );
    expect(ohneNbsp(fest.xml)).not.toContain("Davon entfallen");
  }, 60_000);

  it("Bruttopreise: Aufteilung im Preismodus des Angebots, Summe je Satz unverändert", async () => {
    // Brutto 11.900 € und 2.140 € je Satz wie oben, ohne Rabatt; 30 %: 3.570 € (Arbeit 2.142 €) und 642 € (Arbeit 321 €)
    const quote = await angebot({
      priceMode: "brutto",
      discount: null,
      lines: [
        line("Fliesen", 476_000, 1900),
        line("Verlegen", 714_000, 1900, true),
        line("Pflanzen", 107_000, 700),
        line("Pflanzarbeiten", 107_000, 700, true),
      ],
    });
    const abschlag = await plan.abschlagFromPlan(actor, quote.id, "2026-10-10", 0, null);
    expect(await positionen(abschlag.id)).toEqual([
      [`${text}, Anteil Arbeits-, Maschinen- und Fahrtkosten`, 214_200, 1900, true],
      [`${text}, Anteil Material und Sonstiges`, 142_800, 1900, false],
      [`${text}, Anteil Arbeits-, Maschinen- und Fahrtkosten`, 32_100, 700, true],
      [`${text}, Anteil Material und Sonstiges`, 32_100, 700, false],
    ]);
    expect(abschlag).toMatchObject({ gross: 421_200 });
  }, 60_000);

  it("ohne gekennzeichnete Position bleibt es bei einer Position je Steuersatz", async () => {
    const quote = await angebot({ lines: [line("Fliesen", 400_000, 1900), line("Pflanzen", 100_000, 700)] });
    const abschlag = await plan.abschlagFromPlan(actor, quote.id, "2026-10-10", 0, null);
    expect(await positionen(abschlag.id)).toEqual([
      [text, 108_000, 1900, false],
      [text, 27_000, 700, false],
    ]);
  }, 60_000);
});
