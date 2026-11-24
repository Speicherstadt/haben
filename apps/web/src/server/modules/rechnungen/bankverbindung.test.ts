import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { kleinunternehmerStand } from "../auswertungen/test-umsatz-stand.ts";

/*
 * Weitere Bankverbindungen (#1887): Die aus den Firmendaten bleibt der Standard. Gewählt am Kontakt (Vorgabe) oder am
 * Entwurf, steht die Bankverbindung nach dem Festschreiben im Verkäufer, im PDF und in der E-Rechnung (BT-84, BT-85,
 * BT-86, EN 16931 BG-17). Angebot → Rechnung, Kopie und Storno übernehmen sie. Keine Buchung hängt daran; SKR03 genügt.
 * Alle Daten sind erfunden.
 */

describe.skipIf(!testDatabaseUrl)("Weitere Bankverbindungen an Rechnung, Angebot und Kontakt (Postgres, #1887)", () => {
  let sql: postgres.Sql;
  let invoices: typeof import("./index.ts");
  let quotes: typeof import("./quotes.ts");
  let document: typeof import("./invoice-document.ts");
  let stammdaten: typeof import("../stammdaten/index.ts");
  let integrity: typeof import("../auswertungen/integrity.ts");
  let db: typeof import("../../db/index.ts").db;
  const actor = "test-user";
  const STANDARD = "DE89370400440532013000";
  const NORD = "DE02120300000000202051";
  let contactId: string;
  let nordId: string;

  beforeAll(async () => {
    sql = await setupTestDb();
    invoices = await import("./index.ts");
    quotes = await import("./quotes.ts");
    document = await import("./invoice-document.ts");
    stammdaten = await import("../stammdaten/index.ts");
    integrity = await import("../auswertungen/integrity.ts");
    db = (await import("../../db/index.ts")).db;
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    await leeren(
      sql,
    )`truncate quote_lines, quotes, invoice_lines, invoices, invoice_number_counters, quote_number_counters, contact_versions, contacts, bankverbindungen, journal_lines, journal_entries, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, telefon, steuernummer, ust_id, bundesland, iban, bic, bank, versteuerung, kontenrahmen)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '+49 941 1', '198/113/10010',
              'DE123456789', 'BY', ${STANDARD}, 'COBADEFFXXX', 'Commerzbank', 'ist', 'SKR03')`;
    nordId = (
      await stammdaten.createBankverbindung(actor, {
        bezeichnung: "Objekt Nord",
        iban: NORD,
        bic: "BYLADEM1001",
        bank: "Deutsche Kreditbank",
        kontoinhaber: "Testfirma Objekt Nord",
      })
    ).id;
    contactId = (await stammdaten.createContact(actor, kunde)).id;
  });

  const kunde = {
    kundennummer: "",
    name: "Nordwerk Software GmbH",
    strasse: "Hafenstraße 5",
    plz: "20457",
    ort: "Hamburg",
    land: "DE",
    email: "buchhaltung@nordwerk.example",
    ustId: "",
    iban: "",
    leitwegId: "",
    defaultFormat: null,
  };

  const draftInput = (overrides: Record<string, unknown> = {}) => ({
    contactId,
    issueDate: "2026-09-05",
    serviceFrom: null,
    serviceTo: null,
    paymentTermDays: 14,
    format: "zugferd" as const,
    note: "",
    lines: [{ description: "Miete September", quantity: 1000, unit: "Psch." as const, unitPrice: 100_000, taxRate: 1900 as const }],
    ...overrides,
  });

  /** Zahlungsempfänger in der CII-XML (BG-17) */
  const konto = (xml: string | null) => xml?.match(/<ram:PayeePartyCreditorFinancialAccount>([\s\S]*?)<\/ram:PayeePartyCreditorFinancialAccount>/)?.[1] ?? "";

  it("prüft IBAN und BIC, lehnt die Standard-IBAN und doppelte ab und archiviert statt zu löschen", async () => {
    expect(
      stammdaten.bankverbindungSchema.parse({ bezeichnung: " Rücklage ", iban: "de02 1203 0000 0000 2020 51", bic: "", bank: "", kontoinhaber: "" }),
    ).toMatchObject({
      bezeichnung: "Rücklage",
      iban: NORD,
    });
    expect(stammdaten.bankverbindungSchema.safeParse({ bezeichnung: "X", iban: "DE02120300000000202052", bic: "", bank: "", kontoinhaber: "" }).success).toBe(
      false,
    );
    const leer = { bic: "", bank: "", kontoinhaber: "" };
    await expect(stammdaten.createBankverbindung(actor, { bezeichnung: "Doppelt", iban: NORD, ...leer })).rejects.toThrow("Objekt Nord");
    await expect(stammdaten.createBankverbindung(actor, { bezeichnung: "Standard", iban: STANDARD, ...leer })).rejects.toThrow("Standard-Bankverbindung");
    await expect(sql`delete from bankverbindungen where id = ${nordId}`).rejects.toThrow("nur archiviert");
    await stammdaten.setBankverbindungArchived(actor, nordId, true);
    expect((await stammdaten.listBankverbindungen())[0]?.archivedAt).not.toBeNull();
    // Als Vorgabe am Kontakt nur eine aktive
    await expect(stammdaten.createContact(actor, { ...kunde, name: "Rheinpixel GmbH", bankverbindungId: nordId })).rejects.toThrow("archiviert");
  });

  it("Vorgabe am Kontakt: neuer Entwurf ohne Wahl bekommt sie; festgeschrieben stehen IBAN, BIC und Inhaber im Verkäufer und in der XML", async () => {
    await stammdaten.updateContact(actor, contactId, { ...kunde, bankverbindungId: nordId });
    const draft = await invoices.createDraft(actor, draftInput());
    expect(draft.bankverbindungId).toBe(nordId);
    const invoice = await invoices.finalizeInvoice(actor, draft.id, kleinunternehmerStand);

    expect(invoice.seller).toMatchObject({ iban: NORD, bic: "BYLADEM1001", bank: "Deutsche Kreditbank", kontoinhaber: "Testfirma Objekt Nord" });
    expect(konto(invoice.xml)).toContain(`<ram:IBANID>${NORD}</ram:IBANID>`);
    expect(konto(invoice.xml)).toContain("<ram:AccountName>Testfirma Objekt Nord</ram:AccountName>");
    expect(invoice.xml).not.toContain(STANDARD);

    // Spätere Änderungen an der Bankverbindung berühren die festgeschriebene Rechnung nicht
    await stammdaten.updateBankverbindung(actor, nordId, { bezeichnung: "Objekt Nord", iban: "DE75512108001245126199", bic: "", bank: "", kontoinhaber: "" });
    expect((await invoices.getInvoice(draft.id))?.invoice.seller?.iban).toBe(NORD);
    expect((await integrity.checkIntegrity("2026-09-10")).problems).toEqual([]);
  });

  it("Wahl im Entwurf: null ist der Standard, ohne Angabe bleibt die bisherige, ein anderer Kunde bringt seine Vorgabe mit", async () => {
    const draft = await invoices.createDraft(actor, draftInput({ bankverbindungId: nordId }));
    expect(draft.bankverbindungId).toBe(nordId);
    // Ohne Angabe (API, Zeiteinträge) bleibt die Wahl
    expect((await invoices.updateDraft(actor, draft.id, draftInput())).bankverbindungId).toBe(nordId);
    // Archiviert: die schon gewählte bleibt, neu wählen lässt sie sich nicht
    await stammdaten.setBankverbindungArchived(actor, nordId, true);
    expect((await invoices.updateDraft(actor, draft.id, draftInput({ bankverbindungId: nordId }))).bankverbindungId).toBe(nordId);
    await expect(invoices.createDraft(actor, draftInput({ bankverbindungId: nordId }))).rejects.toThrow("archiviert");
    await stammdaten.setBankverbindungArchived(actor, nordId, false);

    const standard = await invoices.updateDraft(actor, draft.id, draftInput({ bankverbindungId: null }));
    expect(standard.bankverbindungId).toBeNull();
    const invoice = await invoices.finalizeInvoice(actor, draft.id, kleinunternehmerStand);
    expect(invoice.seller).toMatchObject({ iban: STANDARD, bic: "COBADEFFXXX", bank: "Commerzbank" });
    expect(konto(invoice.xml)).toContain(`<ram:IBANID>${STANDARD}</ram:IBANID>`);
  });

  it("Bankabgleich: offene Rechnungen nennen ihr Zielkonto, sobald eine auf eine weitere Bankverbindung lautet", async () => {
    const { openItems } = await import("../bank/offene-posten.ts");
    const standard = await invoices.finalizeInvoice(actor, (await invoices.createDraft(actor, draftInput())).id, kleinunternehmerStand);
    expect((await openItems()).find((i) => i.id === standard.id)?.zielIban).toBeUndefined();
    const nord = await invoices.finalizeInvoice(actor, (await invoices.createDraft(actor, draftInput({ bankverbindungId: nordId }))).id, kleinunternehmerStand);
    const items = await openItems();
    expect(items.find((i) => i.id === nord.id)?.zielIban).toBe(NORD);
    expect(items.find((i) => i.id === standard.id)?.zielIban).toBe(STANDARD);
  });

  it("Storno nennt die Bankverbindung der Rechnung", async () => {
    const draft = await invoices.createDraft(actor, draftInput({ bankverbindungId: nordId }));
    await invoices.finalizeInvoice(actor, draft.id, kleinunternehmerStand);
    const storno = await invoices.cancelInvoice(actor, draft.id, "2026-09-06");
    expect(storno.bankverbindungId).toBe(nordId);
    expect(storno.seller?.iban).toBe(NORD);
  });

  it("Angebot: Wahl im Angebot, beim Festschreiben im Verkäufer, und die Rechnung aus dem Angebot übernimmt sie", async () => {
    const quote = await quotes.createQuoteDraft(actor, {
      contactId,
      bankverbindungId: nordId,
      issueDate: "2026-09-05",
      validUntil: "2026-10-05",
      serviceFrom: null,
      serviceTo: null,
      note: "",
      lines: [{ description: "Beratung", quantity: 1000, unit: "Psch.", unitPrice: 100_000, taxRate: 1900 }],
    });
    const final = await quotes.finalizeQuote(actor, quote.id);
    expect(final.seller?.iban).toBe(NORD);
    const invoice = await quotes.quoteToInvoice(actor, quote.id, "2026-09-10");
    expect(invoice.bankverbindungId).toBe(nordId);
  });

  it("Lastschrift: auf dem Beleg steht der Standard, denn eingezogen wird auf das Gläubigerkonto", async () => {
    const company = await stammdaten.loadCompany();
    expect((await document.draftSeller(db, company, { bankverbindungId: nordId, paymentMethod: "lastschrift" })).iban).toBe(STANDARD);
    expect((await document.draftSeller(db, company, { bankverbindungId: nordId, paymentMethod: "ueberweisung" })).iban).toBe(NORD);
  });
});
