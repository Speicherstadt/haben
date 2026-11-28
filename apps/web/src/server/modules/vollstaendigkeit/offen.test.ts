import type postgres from "postgres";
import type { StripeClient } from "@haben/import";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Was in einem Zeitraum offen ist und wie weit die Umsätze der Konten reichen (#1635). Die Vorprüfung der Voranmeldung zählt
 * damit (vat-figures.test.ts), die BWA ebenso (bwa.test.ts, bwa-form01.test.ts). Alle Daten sind erfunden.
 */

function dkbCsv(iban: string, rows: [date: string, purpose: string, amount: string][], zeitraum?: string) {
  const header = `"Girokonto";"${iban}"\n${zeitraum ? `"Zeitraum:";"${zeitraum}"\n` : ""}""\n`;
  const columns = `"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"\n`;
  const body = rows
    .map(([date, purpose, amount]) =>
      [date, date, "Gebucht", "Nordlicht", "Kunde", purpose, amount.startsWith("-") ? "Ausgang" : "Eingang", "", amount, "", "", ""]
        .map((c) => `"${c}"`)
        .join(";"),
    )
    .join("\n");
  return { bytes: new TextEncoder().encode(`${header}${columns}${body}\n`), filename: `${crypto.randomUUID()}.csv` };
}

const GIRO = "DE12 1203 0000 1234 5678 90";

describe.skipIf(!testDatabaseUrl)("Vollständigkeit: offene Vorgänge und Abdeckung der Konten (Postgres, #1635)", () => {
  let sql: postgres.Sql;
  let bank: typeof import("../bank/index.ts");
  let documents: typeof import("../belege/documents.ts");
  let invoices: typeof import("../rechnungen/index.ts");
  let contacts: typeof import("../stammdaten/contacts.ts");
  let offen: typeof import("./index.ts");
  const actor = "test-user";
  let docSeq = 0;

  beforeAll(async () => {
    sql = await setupTestDb();
    bank = await import("../bank/index.ts");
    documents = await import("../belege/documents.ts");
    invoices = await import("../rechnungen/index.ts");
    contacts = await import("../stammdaten/contacts.ts");
    offen = await import("./index.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    await leeren(
      sql,
    )`truncate psp_connections, allocations, bank_transactions, bank_imports, bank_accounts, document_amounts, documents, invoice_lines, invoices,
      invoice_number_counters, contact_versions, contacts, journal_lines, journal_entries, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, kontenrahmen, versteuerung)
      values (1, 'Nordlicht Software', 'Hafenallee 3', '28217', 'Bremen', 'rechnung@example.com', '60/145/12345', 'HB', 'SKR03', 'ist')`;
  });

  async function beleg(documentDate: string | null) {
    docSeq++;
    const { id } = await documents.uploadDocument(actor, { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, docSeq % 256, 7]), filename: `b${docSeq}.jpg` });
    if (documentDate)
      await documents.updateDocument(actor, id, {
        supplierName: "Rechenzentrum Süd",
        supplierUstId: "",
        invoiceNumber: `R${docSeq}`,
        documentDate,
        dueDate: null,
        category: "software",
        payment: "bank",
        note: "",
        amounts: [{ taxRate: 1900, net: 1_000, tax: 190 }],
        privateShare: 0,
        reverseCharge: null,
      });
  }

  async function entwurf(issueDate: string) {
    const { id: contactId } = await contacts.createContact(actor, {
      kundennummer: "",
      name: "Nordwerk Software GmbH",
      strasse: "Hafenstraße 5",
      plz: "20457",
      ort: "Hamburg",
      land: "DE",
      email: "a@b.example",
      ustId: "",
      iban: "",
      leitwegId: "",
      defaultFormat: null,
    });
    await invoices.createDraft(actor, {
      contactId,
      issueDate,
      serviceFrom: null,
      serviceTo: null,
      paymentTermDays: 14,
      format: "zugferd",
      note: "",
      lines: [{ description: "Leistung", quantity: 1000, unit: "Psch." as const, unitPrice: 10_000, taxRate: 1900 }],
    });
  }

  it("zählt offene Umsätze, Belege „neu“ und Entwürfe im Zeitraum; Belege ohne Datum immer, Ende ausschließend", async () => {
    const { accountId } = await bank.importStatement(
      actor,
      dkbCsv(GIRO, [
        ["28.02.26", "vor dem Zeitraum", "-10,00"],
        ["02.03.26", "Hosting", "-20,00"],
        ["10.03.26", "Hosting", "-30,00"],
        ["15.03.26", "Kunde A", "100,00"],
        ["16.03.26", "Kunde B", "200,00"],
        ["01.04.26", "nach dem Zeitraum", "-40,00"],
      ]),
      null,
    );
    // Ein zugeordneter Umsatz ist erledigt, auch ohne Beleg (bankOpenAmountSql)
    const [b] = await sql<{ id: string }[]>`select id from bank_transactions where amount = -2000 and bank_account_id = ${accountId}`;
    await bank.allocate(actor, { kind: "ustVorauszahlung", transactionId: b!.id, amount: -2_000 });
    await beleg("2026-03-05");
    await beleg("2026-04-01");
    await beleg(null);
    await entwurf("2026-03-31");
    await entwurf("2026-04-01");

    expect(await offen.offeneVorgaenge("2026-03-01", "2026-04-01")).toEqual({ ausgaben: 1, eingaenge: 2, belege: 2, rechnungsentwuerfe: 1 });
    expect(await offen.offeneVorgaenge("2026-01-01", "2026-02-01")).toEqual({ ausgaben: 0, eingaenge: 0, belege: 1, rechnungsentwuerfe: 0 });
  }, 60_000);

  it("Abdeckung: spätestes Importende oder letzter Umsatz; mit Rücklagekonten, ohne private und ausgeschlossene", async () => {
    // Auszug bis Monatsende, letzter Umsatz am 20.: Der Auszug sagt, dass danach nichts kam
    const giro = await bank.importStatement(actor, dkbCsv(GIRO, [["20.03.26", "Hosting", "-20,00"]], "01.03.2026 - 31.03.2026"), null);
    // Ohne Zeitraum im Auszug reicht er bis zum letzten Umsatz
    const visa = await bank.importStatement(actor, dkbCsv("DE89 3704 0044 0532 0130 00", [["12.03.26", "Hosting", "-20,00"]]), null);
    const privat = await bank.importStatement(actor, dkbCsv("DE02 1001 0010 0006 8201 01", [["01.03.26", "Miete", "-500,00"]]), null);
    const ruecklage = await bank.importStatement(actor, dkbCsv("DE02 5001 0517 0137 1471 85", [["01.03.26", "Rücklage", "500,00"]]), null);
    const fremd = await bank.importStatement(actor, dkbCsv("DE75 5121 0800 1245 1261 99", [["01.03.26", "fremd", "5,00"]]), null);
    await bank.updateAccount(actor, { id: privat.accountId, name: "Privat", purpose: "privat" });
    await bank.updateAccount(actor, { id: ruecklage.accountId, name: "Rücklage", purpose: "ruecklage" });
    await bank.updateAccount(actor, { id: giro.accountId, name: "Girokonto", purpose: "geschaeft" });
    await bank.updateAccount(actor, { id: visa.accountId, name: "Visa", purpose: "steuer" });
    await bank.excludeAccount(actor, fremd.accountId);
    const leer = await bank.createAccount(actor, { name: "Tagesgeld", iban: "DE44 5001 0517 5407 3249 31" });

    expect(await offen.kontoAbdeckung()).toEqual([
      { id: giro.accountId, name: "Girokonto", bis: "2026-03-31" },
      // Rücklagekonten buchen auf 1200/1800, ihre Zinsen sind Betriebseinnahmen
      { id: ruecklage.accountId, name: "Rücklage", bis: "2026-03-01" },
      { id: leer.id, name: "Tagesgeld", bis: null },
      { id: visa.accountId, name: "Visa", bis: "2026-03-12" },
    ]);
  }, 60_000);

  it("Abdeckung mit Abruf: der Tag vor dem letzten erfolgreichen Abruf, in Berlin; nach einem Fehler nur der Import", async () => {
    // Der Abruf speichert als Ende nur seinen letzten Umsatz (30.10.), ein Abruf ohne neue Umsätze gar keinen Import
    const stripe = await bank.createProviderAccount(actor, { name: "Stripe", provider: "stripe" });
    const paypal = await bank.createProviderAccount(actor, { name: "PayPal", provider: "paypal" });
    for (const konto of [stripe, paypal])
      await sql`insert into bank_imports (bank_account_id, filename, sha256, format, period_from, period_to, added, skipped)
        values (${konto.id}, 'abruf.json', 'abc', 'stripe', '2026-10-01', '2026-10-30', 1, 0)`;
    // 23:30 UTC ist in Berlin schon der 24.11.
    await sql`insert into psp_connections (provider, name, account_id, ciphertext, fetch_from, abruf_start, bank_account_id, last_sync_at)
      values ('stripe', 'Stripe', 'acct_beispiel', '\\x00', '2026-11-20', '2026-10-01', ${stripe.id}, '2026-11-23T23:30:00Z')`;
    // Der letzte Anlauf schlug fehl: Der Zeitplan setzt last_sync_at trotzdem, abgerufen ist damit nichts
    await sql`insert into psp_connections (provider, name, account_id, ciphertext, fetch_from, abruf_start, bank_account_id, last_sync_at, last_error)
      values ('paypal', 'PayPal', 'HAENDLER1', '\\x00', '2026-11-20', '2026-10-01', ${paypal.id}, '2026-11-24T10:00:00Z', 'Abruf fehlgeschlagen: 503')`;

    expect(await offen.kontoAbdeckung()).toEqual([
      { id: paypal.id, name: "PayPal", bis: "2026-10-30" },
      { id: stripe.id, name: "Stripe", bis: "2026-11-23" },
    ]);
  }, 60_000);

  it("Abdeckung mit Abruf: ein fehlgeschlagener Anlauf zählt auch nach neuem Schlüssel oder anderem Konto nicht", async () => {
    const psp = await import("../zahlungsdienstleister/index.ts");
    // Der alte Schlüssel ist abgelaufen; der neue gehört zum selben Konto bei Stripe, der dritte zu einem anderen
    const acct: Record<string, string> = { rk_live_altaaaaaaaaaaa: "acct_shop", rk_live_neuaaaaaaaaaaa: "acct_shop", rk_live_andereaaaaaaa: "acct_kurse" };
    psp.setStripeClientFactory(
      ({ apiKey }) =>
        ({
          accountId: async () => acct[apiKey],
          balanceTransactions: async () => {
            throw new Error("401 abgelaufen");
          },
        }) as unknown as StripeClient,
    );
    const konto = await bank.createProviderAccount(actor, { name: "Stripe", provider: "stripe" });
    const eingabe = { provider: "stripe", name: "Stripe", bankAccountId: konto.id, fetchFrom: "2026-10-01" } as const;
    const { id } = await psp.speichereVerbindung(actor, { ...eingabe, eingabe: { apiKey: "rk_live_altaaaaaaaaaaa" } });
    const fehlgeschlagen = async () => {
      // Der Zeitplan setzt last_sync_at auch nach dem Fehler
      expect((await psp.runDuePspSyncs(new Date("2026-11-24T10:00:00Z"))).errors).toHaveLength(1);
      expect(await offen.kontoAbdeckung()).toEqual([{ id: konto.id, name: "Stripe", bis: null }]);
    };
    await fehlgeschlagen();
    // Der neue Schlüssel löscht den Fehler, abgerufen ist damit noch nichts
    await psp.speichereVerbindung(actor, { ...eingabe, id, eingabe: { apiKey: "rk_live_neuaaaaaaaaaaa" } });
    expect(await offen.kontoAbdeckung()).toEqual([{ id: konto.id, name: "Stripe", bis: null }]);
    await sql`update psp_connections set last_sync_at = null, last_error = null where id = ${id}`;
    await fehlgeschlagen();
    // Ebenso ein anderes Konto beim Anbieter
    await psp.speichereVerbindung(actor, { ...eingabe, id, eingabe: { apiKey: "rk_live_andereaaaaaaa" } });
    expect(await offen.kontoAbdeckung()).toEqual([{ id: konto.id, name: "Stripe", bis: null }]);
  }, 60_000);
});
