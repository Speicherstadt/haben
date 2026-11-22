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
  const dir = mkdtempSync(join(tmpdir(), "haben-35a-"));
  try {
    writeFileSync(join(dir, "beleg.pdf"), pdf);
    return execFileSync("pdftotext", [join(dir, "beleg.pdf"), "-"], { encoding: "utf8" }).replace(/\s+/g, " ");
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Anteil der Arbeits-, Maschinen- und Fahrtkosten (§ 35a EStG, #712): Kennzeichen je Position, Satz unter den Summen und im XML
describe.skipIf(!testDatabaseUrl)("Arbeits-, Maschinen- und Fahrtkosten nach § 35a EStG (Postgres, #712)", () => {
  let invoices: typeof import("./index.ts");
  let quotes: typeof import("./quotes.ts");
  let recurring: typeof import("./recurring.ts");
  let contacts: typeof import("../stammdaten/contacts.ts");
  let stammdaten: typeof import("../stammdaten/index.ts");
  let sql: postgres.Sql;
  let contactId: string;
  const actor = "test-user";

  beforeAll(async () => {
    sql = await setupTestDb();
    invoices = await import("./index.ts");
    quotes = await import("./quotes.ts");
    recurring = await import("./recurring.ts");
    contacts = await import("../stammdaten/contacts.ts");
    stammdaten = await import("../stammdaten/index.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    await leeren(sql)`truncate articles, recurring_invoices, quote_lines, quotes, quote_number_counters, journal_lines, journal_entries,
      invoice_lines, invoices, invoice_number_counters, contact_versions, contacts, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, ust_id, bundesland, iban, bic, bank, payment_term_days)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'DE123456789', 'BY',
              'DE89370400440532013000', 'COBADEFFXXX', 'Commerzbank', 14)`;
    const contact = await contacts.createContact(actor, {
      kundennummer: "10001",
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

  // Beispiel aus #712, mit 19 %: 3 Melder je 31,00 €, Montage 3 × 8,00 €, Anfahrt 35,00 € → Arbeit und Fahrt 59,00 € netto, 70,21 € brutto
  const melder = { description: "Rauchwarnmelder", quantity: 3000, unit: "Stk." as const, unitPrice: 3100, taxRate: 1900 as const };
  const montage = { description: "Montage", quantity: 3000, unit: "Stk." as const, unitPrice: 800, taxRate: 1900 as const, arbeitskosten: true };
  const anfahrt = { description: "Anfahrt", quantity: 1000, unit: "Psch." as const, unitPrice: 3500, taxRate: 1900 as const, arbeitskosten: true };
  const satz = "Darin sind Arbeits-, Maschinen- und Fahrtkosten von 70,21 € inkl. USt enthalten (§ 35a EStG).";
  const entwurf = (lines: object[]) =>
    invoices.createDraft(actor, {
      contactId,
      issueDate: "2026-11-02",
      serviceFrom: null,
      serviceTo: null,
      paymentTermDays: 14,
      format: "zugferd",
      note: "",
      lines: lines as never,
    });
  /** Betrag und Währung trennt ein geschütztes Leerzeichen (formatEuro) */
  const ohneNbsp = (text: string | null | undefined) => (text ?? "").replace(/[\u00a0\u202f]/g, " ");
  const kennzeichen = async (table: "invoice_lines" | "quote_lines", column: "invoice_id" | "quote_id", id: string) =>
    (await sql`select arbeitskosten from ${sql(table)} where ${sql(column)} = ${id} order by position`).map((r) => r.arbeitskosten);

  it("nennt den Anteil in PDF und XML der festgeschriebenen Rechnung; Storno und Kopie behalten das Kennzeichen", async () => {
    const rechnung = await invoices.finalizeInvoice(actor, (await entwurf([melder, montage, anfahrt])).id, kleinunternehmerStand);
    expect(await kennzeichen("invoice_lines", "invoice_id", rechnung.id)).toEqual([false, true, true]);
    expect(ohneNbsp(rechnung.xml)).toContain(satz);
    expect(rechnung.pdf).toBeTruthy();
    const text = pdfText(rechnung.pdf!);
    if (text !== null) expect(text).toContain(satz);

    const storno = await invoices.cancelInvoice(actor, rechnung.id, "2026-11-03");
    expect(await kennzeichen("invoice_lines", "invoice_id", storno.id)).toEqual([false, true, true]);
    expect(ohneNbsp(storno.xml)).toMatch(/Arbeits-, Maschinen- und Fahrtkosten von [-−]70,21 €/);

    const kopie = await invoices.copyInvoice(actor, rechnung.id, "2026-12-01");
    expect(await kennzeichen("invoice_lines", "invoice_id", kopie.id)).toEqual([false, true, true]);
  }, 60_000);

  it("ohne Kennzeichen kein Satz; die Rechnung bleibt wie bisher", async () => {
    const rechnung = await invoices.finalizeInvoice(actor, (await entwurf([melder, { ...montage, arbeitskosten: false }])).id, kleinunternehmerStand);
    expect(await kennzeichen("invoice_lines", "invoice_id", rechnung.id)).toEqual([false, false]);
    expect(rechnung.xml).not.toContain("§ 35a");
  }, 60_000);

  it("Angebot: optionale Positionen zählen nicht mit; Kopie und Rechnung aus dem Angebot behalten das Kennzeichen", async () => {
    const angebotsEntwurf = await quotes.createQuoteDraft(actor, {
      contactId,
      issueDate: "2026-11-02",
      validUntil: "2026-11-30",
      serviceFrom: null,
      serviceTo: null,
      intro: "",
      note: "",
      lines: [melder, montage, anfahrt, { ...anfahrt, description: "Zweite Anfahrt", kind: "optional" }] as never,
    });
    const angebot = await quotes.finalizeQuote(actor, angebotsEntwurf.id);
    expect(await kennzeichen("quote_lines", "quote_id", angebot.id)).toEqual([false, true, true, true]);
    const pdf = await quotes.loadQuotePdf(angebot.id);
    expect(pdf).not.toBeNull();
    const text = pdfText(pdf!.pdf);
    if (text !== null) expect(text).toContain(satz);

    const kopie = await quotes.copyQuote(actor, angebot.id, "2026-12-01");
    expect(await kennzeichen("quote_lines", "quote_id", kopie.id)).toEqual([false, true, true, true]);
    await quotes.setQuoteDecision(actor, angebot.id, "angenommen");
    const ausAngebot = await quotes.quoteToInvoice(actor, angebot.id, "2026-12-01");
    expect((await kennzeichen("invoice_lines", "invoice_id", ausAngebot.id)).slice(0, 3)).toEqual([false, true, true]);
  }, 60_000);

  it("der Artikel bringt das Kennzeichen als Vorgabe mit; die wiederkehrende Rechnung gibt es an jede Rechnung weiter", async () => {
    const artikel = await stammdaten.createArticle(actor, {
      description: "Wartung Rauchwarnmelder",
      unit: "Stk.",
      unitPrice: 800,
      taxRate: 1900,
      arbeitskosten: true,
    });
    expect(artikel.arbeitskosten).toBe(true);
    expect((await stammdaten.createArticle(actor, { description: "Batterie", unit: "Stk.", unitPrice: 500, taxRate: 1900 })).arbeitskosten).toBe(false);

    await recurring.createRecurring(actor, {
      name: "Wartung Erika Mustermann",
      active: true,
      contactId,
      format: "zugferd",
      paymentTermDays: 14,
      note: "",
      taxTreatment: "regulaer",
      exemptionReason: "",
      lines: [
        { ...melder, quantity: 1000 },
        { ...montage, quantity: 1000 },
      ],
      recurrence: "P1Y" as const,
      nextDate: "2026-11-02",
      endDate: null,
      servicePeriod: "laufend",
      mode: "entwurf",
    });
    expect((await recurring.runDueRecurring("2026-11-02", kleinunternehmerStand)).created).toBe(1);
    const [erzeugt] = await sql`select id from invoices`;
    expect(await kennzeichen("invoice_lines", "invoice_id", erzeugt!.id)).toEqual([false, true]);
  }, 60_000);
});
