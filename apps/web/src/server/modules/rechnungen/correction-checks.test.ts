import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { kleinunternehmerStand } from "../auswertungen/test-umsatz-stand.ts";

/*
 * Festschreiben einer Rechnungskorrektur (#2037). Eine Korrektur über den vollen, noch unbezahlten Rechnungsbetrag
 * hebt die Rechnung auf und ist ein Storno; das wird abgewiesen, bevor versiegelt wird, statt erst beim Verrechnen
 * (#877). Die Regel rechnet netto in der Währung der Rechnung und nur, solange nichts bezahlt ist; eine Schlussrechnung
 * und eine als bereits bezahlt ausgestellte Rechnung sind ausgenommen.
 */
describe.skipIf(!testDatabaseUrl)("Rechnungskorrektur: Festschreiben (Postgres)", () => {
  let invoices: typeof import("./index.ts");
  let contacts: typeof import("../stammdaten/contacts.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  let contactId: string;

  beforeAll(async () => {
    sql = await setupTestDb();
    invoices = await import("./index.ts");
    contacts = await import("../stammdaten/contacts.ts");
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
  });

  /** Entwurf einer Rechnung oder Korrektur, eine Zeile, brutto = netto × 1,19 */
  async function entwurf(art: "rechnung" | "korrektur", netto: number, correctsFor?: string) {
    return invoices.createDraft(
      actor,
      {
        contactId,
        issueDate: "2026-09-01",
        serviceFrom: null,
        serviceTo: null,
        paymentTermDays: 14,
        format: "zugferd",
        note: "",
        lines: [{ description: "Beratung", quantity: 1000, unit: "Psch.", unitPrice: netto, taxRate: 1900 }],
      },
      art === "korrektur" ? { kind: "korrektur", correctsId: correctsFor! } : {},
    );
  }

  /** Schreibt fest und gibt die Id zurück */
  async function fest(art: "rechnung" | "korrektur", netto: number, correctsFor?: string): Promise<string> {
    const draft = await entwurf(art, netto, correctsFor);
    return (await invoices.finalizeInvoice(actor, draft.id, kleinunternehmerStand)).id;
  }

  /** Zahlungseingang über die Bank, wie aus dem Kontoauszug */
  async function zahle(invoiceId: string, betrag: number): Promise<void> {
    const [konto] = await sql`insert into bank_accounts (name, iban, purpose) values ('Geschäftskonto', 'DE89370400440532013000', 'geschaeft') returning id`;
    const [import_] = await sql`
      insert into bank_imports (bank_account_id, filename, sha256, format, added, skipped)
      values (${(konto as { id: string }).id}, 'umsatz.csv', ${"a".repeat(64)}, 'swan', 1, 0) returning id`;
    const [umsatz] = await sql`
      insert into bank_transactions (bank_account_id, import_id, booking_date, amount, counterparty_name, dedup_hash)
      values (${(konto as { id: string }).id}, ${(import_ as { id: string }).id}, '2026-10-01', ${betrag}, 'Nordwerk Software GmbH', ${`h${betrag}`})
      returning id`;
    const bank = await import("../bank/index.ts");
    await bank.allocate(actor, { kind: "invoice", transactionId: (umsatz as { id: string }).id, invoiceId, amount: betrag });
  }

  async function offen(id: string): Promise<number> {
    const [row] = await invoices.listInvoices("2026-11-20", id);
    return row!.open;
  }

  beforeEach(async () => {
    await leeren(sql)`truncate invoice_settlements, dunnings, journal_lines, journal_entries, allocations, write_offs,
      cash_entries, invoice_taxes, invoice_lines, invoices, invoice_number_counters, bank_transactions, bank_imports,
      bank_accounts, contact_versions, contacts, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, telefon, steuernummer, ust_id, bundesland, iban,
        versteuerung, kontenrahmen, payment_term_days)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '+49 941 1', '198/113/10010',
              'DE123456789', 'BY', 'DE89370400440532013000', 'soll', 'SKR03', 14)`;
    const contact = await contacts.createContact(actor, {
      kundennummer: "10001",
      name: "Nordwerk Software GmbH",
      strasse: "Hafenstraße 5",
      plz: "20457",
      ort: "Hamburg",
      land: "DE",
      email: "rechnung@nordwerk.example",
      ustId: "",
      iban: "",
      leitwegId: "",
      defaultFormat: null,
    });
    contactId = contact.id;
  }, 60_000);

  it("weist eine Korrektur über den vollen, unbezahlten Rechnungsbetrag beim Festschreiben ab", async () => {
    const rechnung = await fest("rechnung", 13_361);
    expect(await offen(rechnung)).toBe(15_900);

    const korrektur = await entwurf("korrektur", -13_361, rechnung);
    await expect(invoices.finalizeInvoice(actor, korrektur.id, kleinunternehmerStand)).rejects.toThrow(/ist ein Storno/);

    // Der Entwurf bleibt Entwurf, nichts ist versiegelt
    const [zeile] = await invoices.listInvoices("2026-11-20", korrektur.id);
    expect(zeile).toMatchObject({ status: "draft" });
  }, 60_000);

  it("weist zwei Teilkorrekturen ab, die zusammen genau aufheben", async () => {
    const rechnung = await fest("rechnung", 13_361);
    await fest("korrektur", -6_000, rechnung);

    const zweite = await entwurf("korrektur", -7_361, rechnung);
    await expect(invoices.finalizeInvoice(actor, zweite.id, kleinunternehmerStand)).rejects.toThrow(/ist ein Storno/);
  }, 60_000);

  it("lässt eine Teilkorrektur festzuschreiben", async () => {
    const rechnung = await fest("rechnung", 13_361);
    const teil = await fest("korrektur", -1_471, rechnung);
    expect(await offen(rechnung)).toBe(15_900);
    expect(await offen(teil)).toBe(-1_750);
  }, 60_000);

  it("lässt eine Korrektur über den vollen Betrag zu, wenn die Rechnung schon teilbezahlt ist", async () => {
    const rechnung = await fest("rechnung", 13_361);
    await zahle(rechnung, 5_900);
    expect(await offen(rechnung)).toBe(10_000);

    // Der Kunde schuldet noch 100,00 EUR; eine Korrektur über den vollen Betrag erzeugt ein Guthaben
    const korrektur = await fest("korrektur", -13_361, rechnung);
    expect(await offen(korrektur)).toBe(-15_900);
  }, 60_000);

  it("lässt eine Korrektur über den vollen Betrag zu, wenn die Rechnung voll bezahlt ist", async () => {
    const rechnung = await fest("rechnung", 13_361);
    await zahle(rechnung, 15_900);
    expect(await offen(rechnung)).toBe(0);

    const korrektur = await fest("korrektur", -13_361, rechnung);
    expect(await offen(korrektur)).toBe(-15_900);
  }, 60_000);

  it("meldet nur einen Grund, nicht beide Prüfungen", async () => {
    const rechnung = await fest("rechnung", 13_361);
    const korrektur = await entwurf("korrektur", -13_361, rechnung);
    const gruende = await (await import("./invoice-finalize.ts")).finalizeIssues(korrektur.id);
    const treffer = gruende.filter((g) => /ist ein Storno|unter 0/.test(g));
    expect(treffer).toHaveLength(1);
    expect(treffer[0]).toMatch(/ist ein Storno/);
  }, 60_000);
  it("Fremdwährung: lässt eine Korrektur zu, die in der Rechnungswährung einen Rest übrig lässt", async () => {
    // 100,00 USD und −99,99 USD ergeben beim Kurs 1,20 in Euro dieselben Cent; in USD bleibt 0,01 offen
    const usd = (netto: number) => ({
      contactId,
      issueDate: "2026-09-01",
      serviceFrom: null,
      serviceTo: null,
      paymentTermDays: 14,
      format: "zugferd" as const,
      note: "",
      currency: "USD",
      exchangeRate: "1,20",
      lines: [{ description: "Beratung", quantity: 1000, unit: "Psch." as const, unitPrice: netto, taxRate: 1900 as const }],
    });
    const rechnung = await invoices.finalizeInvoice(actor, (await invoices.createDraft(actor, usd(10_000))).id, kleinunternehmerStand);
    const entwurf = await invoices.createDraft(actor, usd(-9_999), { kind: "korrektur", correctsId: rechnung.id });
    const korrektur = await invoices.finalizeInvoice(actor, entwurf.id, kleinunternehmerStand);
    expect(korrektur).toMatchObject({ kind: "korrektur", status: "final" });
  }, 60_000);

  it("lässt eine Korrektur über den vollen Betrag einer als bereits bezahlt ausgestellten Rechnung zu", async () => {
    // Die Rechnung sagt dem Kunden „bereits bezahlt“ (XML: TotalPrepaidAmount); vor dem Abgleich bleibt sie in der Liste offen
    const draft = await invoices.createDraft(actor, {
      contactId,
      issueDate: "2026-09-01",
      serviceFrom: null,
      serviceTo: null,
      paymentTermDays: 14,
      format: "zugferd",
      note: "",
      paymentMethod: "bereits_bezahlt",
      paidVia: "PayPal",
      paidOn: "2026-09-01",
      lines: [{ description: "Beratung", quantity: 1000, unit: "Psch.", unitPrice: 13_361, taxRate: 1900 }],
    });
    const rechnung = (await invoices.finalizeInvoice(actor, draft.id, kleinunternehmerStand)).id;
    const korrektur = await entwurf("korrektur", -13_361, rechnung);
    expect(await invoices.finalizeInvoice(actor, korrektur.id, kleinunternehmerStand)).toMatchObject({ kind: "korrektur", status: "final" });
  }, 60_000);

  it("weist Korrekturen ab, die netto aufheben, auch wenn die je Beleg gerundete Steuer 1 Cent mehr zurücknimmt", async () => {
    // 100,00 netto; −0,50 rundet −0,095 auf −0,10 USt, −99,50 rundet −18,905 auf −18,91: brutto −0,01 statt 0
    const rechnung = await fest("rechnung", 10_000);
    await fest("korrektur", -50, rechnung);
    const zweite = await entwurf("korrektur", -9_950, rechnung);
    await expect(invoices.finalizeInvoice(actor, zweite.id, kleinunternehmerStand)).rejects.toThrow(/ist ein Storno/);
  }, 60_000);

  it("weist Korrekturen ab, die netto aufheben, auch wenn brutto 1 Cent offen bliebe", async () => {
    // 1,03 netto mit 0,20 USt; drei Korrekturen −0,34 / −0,34 / −0,35 nehmen nur 0,19 USt zurück
    const rechnung = await fest("rechnung", 103);
    await fest("korrektur", -34, rechnung);
    await fest("korrektur", -34, rechnung);
    const dritte = await entwurf("korrektur", -35, rechnung);
    await expect(invoices.finalizeInvoice(actor, dritte.id, kleinunternehmerStand)).rejects.toThrow(/ist ein Storno/);
  }, 60_000);

  it("Fremdwährung: weist eine Korrektur ab, die in der Rechnungswährung unter 0 mindert", async () => {
    // 99,99 USD und −100,00 USD ergeben beim Kurs 1,20 in Euro dieselben Cent; in USD fehlt 0,01
    const usd = (netto: number) => ({
      contactId,
      issueDate: "2026-09-01",
      serviceFrom: null,
      serviceTo: null,
      paymentTermDays: 14,
      format: "zugferd" as const,
      note: "",
      currency: "USD",
      exchangeRate: "1,20",
      lines: [{ description: "Beratung", quantity: 1000, unit: "Psch." as const, unitPrice: netto, taxRate: 1900 as const }],
    });
    const rechnung = await invoices.finalizeInvoice(actor, (await invoices.createDraft(actor, usd(9_999))).id, kleinunternehmerStand);
    const entwurf = await invoices.createDraft(actor, usd(-10_000), { kind: "korrektur", correctsId: rechnung.id });
    await expect(invoices.finalizeInvoice(actor, entwurf.id, kleinunternehmerStand)).rejects.toThrow(/unter 0/);
  }, 60_000);
});
