import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { kleinunternehmerStand } from "../auswertungen/test-umsatz-stand.ts";

/*
 * Forderungsausfall in der Voranmeldung (#1267): Ist das Entgelt uneinbringlich (§ 17 Abs. 2 Nr. 1 Satz 1 UStG), mindert
 * die Ausbuchung bei Soll Kz 81 bzw. 86 und steht zusätzlich in Kz 50 (Anleitung zur UStVA 2026, Kz 50). Bei Ist war der
 * ausgefallene Rest nie angemeldet, es gibt nichts zu mindern. Gesendete Voranmeldungen ohne Kz 50 bleiben, wie sie sind.
 */
describe.skipIf(!testDatabaseUrl)("Forderungsausfall in Kz 50 (Postgres)", () => {
  let vat: typeof import("./index.ts");
  let bank: typeof import("../bank/index.ts");
  let invoices: typeof import("../rechnungen/index.ts");
  let contacts: typeof import("../stammdaten/contacts.ts");
  let sql: postgres.Sql;
  const actor = "kz50-test";
  const oktober = { year: 2026, month: 10 };

  beforeAll(async () => {
    sql = await setupTestDb();
    vat = await import("./index.ts");
    bank = await import("../bank/index.ts");
    invoices = await import("../rechnungen/index.ts");
    contacts = await import("../stammdaten/contacts.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function firma(kontenrahmen: "SKR03" | "SKR04", versteuerung: "ist" | "soll") {
    await leeren(sql)`truncate vat_return_submissions, vat_returns, write_offs, allocations, bank_transactions, bank_imports,
      bank_accounts, journal_lines, journal_entries, invoice_lines, invoices, invoice_number_counters, contact_versions, contacts,
      company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, telefon, steuernummer, ust_id, bundesland, iban, versteuerung, kontenrahmen)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '+49 941 1', '198/113/10010',
              'DE123456789', 'BY', 'DE89370400440532013000', ${versteuerung}, ${kontenrahmen})`;
  }

  /** Rechnung vom 20.09.2026: 1.000,00 € zu 19 % und 500,00 € zu 7 %, brutto 1.725,00 € */
  async function rechnung() {
    const contact = await contacts.createContact(actor, {
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
    const draft = await invoices.createDraft(actor, {
      contactId: contact.id,
      issueDate: "2026-09-20",
      serviceFrom: null,
      serviceTo: null,
      paymentTermDays: 14,
      format: "zugferd",
      note: "",
      lines: [
        { description: "Beratung", quantity: 1000, unit: "Psch.", unitPrice: 100_000, taxRate: 1900 },
        { description: "Fachbuch", quantity: 1000, unit: "Stk.", unitPrice: 50_000, taxRate: 700 },
      ],
    });
    return invoices.finalizeInvoice(actor, draft.id, kleinunternehmerStand);
  }

  const xmlDesEntwurfs = async (id: string) => new TextDecoder("latin1").decode((await vat.meinElsterUpload(id)).bytes);

  for (const kontenrahmen of ["SKR03", "SKR04"] as const) {
    it(`Soll (${kontenrahmen}): Forderungsausfall mindert Kz 81 und 86 und steht in Kz 50, im Entwurf und im XML`, async () => {
      await firma(kontenrahmen, "soll");
      const inv = await rechnung();
      await bank.writeOff(actor, { kind: "forderungsausfall", invoiceId: inv.id, date: "2026-10-05" });

      expect(await vat.computeVatFigures(oktober)).toMatchObject({ kz81: -100_000, kz86: -50_000, kz50: 150_000 });
      expect((await vat.computeVatFigures({ year: 2026, month: 9 })).kz50).toBe(0);
      const entwurf = await vat.saveDraft(actor, oktober, { mode: "berechnet" });
      expect(entwurf).toMatchObject({ kz81: -100_000, kz86: -50_000, kz50: 150_000, computed: expect.objectContaining({ kz50: 150_000 }) });
      expect(await xmlDesEntwurfs(entwurf.id)).toContain("<Kz50>1500</Kz50>");
    });

    it(`Ist (${kontenrahmen}): Forderungsausfall ohne Zahlung meldet nichts, auch kein Kz 50`, async () => {
      await firma(kontenrahmen, "ist");
      const inv = await rechnung();
      await bank.writeOff(actor, { kind: "forderungsausfall", invoiceId: inv.id, date: "2026-10-05" });

      expect(await vat.computeVatFigures(oktober)).toMatchObject({ kz81: 0, kz86: 0, kz50: 0 });
      const entwurf = await vat.saveDraft(actor, oktober, { mode: "berechnet" });
      expect(await xmlDesEntwurfs(entwurf.id)).not.toContain("<Kz50>");
    });
  }

  it("Soll: gewährtes Skonto mindert Kz 81, aber nicht Kz 50", async () => {
    await firma("SKR03", "soll");
    const inv = await rechnung();
    await bank.writeOff(actor, { kind: "skonto", invoiceId: inv.id, date: "2026-10-05", amount: 3_450 });

    const f = await vat.computeVatFigures(oktober);
    expect(f.kz81 + f.kz86).toBeLessThan(0);
    expect(f.kz50).toBe(0);
  });

  it("Soll: Aufhebung im Folgemonat nimmt Kz 81 und 86 zurück, Kz 50 bleibt dort leer statt negativ", async () => {
    await firma("SKR04", "soll");
    const inv = await rechnung();
    await bank.writeOff(actor, { kind: "forderungsausfall", invoiceId: inv.id, date: "2026-10-05" });
    const [w] = await bank.listWriteOffs({ invoiceId: inv.id });
    await bank.reverseWriteOff(actor, w!.id, "2026-11-03");

    expect(await vat.computedValues({ year: 2026, month: 11 })).toMatchObject({ kz81: 100_000, kz86: 50_000, kz50: 0 });
    expect((await vat.computedValues(oktober)).kz50).toBe(150_000);
  });

  // Der Wiedereingang (§ 17 Abs. 2 Nr. 1 Satz 2 UStG) erhöht Kz 81/86; Kz 50 nennt nur Minderungen nach Satz 1
  it("Soll: Aufhebung eines Forderungsausfalls aus dem Vormonat mindert einen neuen Forderungsausfall in Kz 50 nicht", async () => {
    await firma("SKR03", "soll");
    const alt = await rechnung();
    const neu = await rechnung();
    await bank.writeOff(actor, { kind: "forderungsausfall", invoiceId: alt.id, date: "2026-10-05" });
    await bank.writeOff(actor, { kind: "forderungsausfall", invoiceId: neu.id, date: "2026-11-10" });
    const [w] = await bank.listWriteOffs({ invoiceId: alt.id });
    await bank.reverseWriteOff(actor, w!.id, "2026-11-12");

    expect(await vat.computedValues({ year: 2026, month: 11 })).toMatchObject({ kz81: 0, kz86: 0, kz50: 150_000 });
  });

  it("Soll: Forderungsausfall und Aufhebung im selben Monat heben sich auch in Kz 50 auf", async () => {
    await firma("SKR04", "soll");
    const inv = await rechnung();
    await bank.writeOff(actor, { kind: "forderungsausfall", invoiceId: inv.id, date: "2026-10-05" });
    const [w] = await bank.listWriteOffs({ invoiceId: inv.id });
    await bank.reverseWriteOff(actor, w!.id, "2026-10-20");

    expect(await vat.computedValues(oktober)).toMatchObject({ kz81: 0, kz86: 0, kz50: 0 });
  });

  it("Gesendete Voranmeldung von vor Kz 50 meldet im Abgleich keine Abweichung", async () => {
    await firma("SKR03", "soll");
    const inv = await rechnung();
    await bank.writeOff(actor, { kind: "forderungsausfall", invoiceId: inv.id, date: "2026-10-05" });
    const entwurf = await vat.saveDraft(actor, oktober, { mode: "berechnet" });
    // So steht eine vor dieser Änderung gesendete Anmeldung da: Kz 81/86 gemindert, Kz 50 leer (Standardwert der Migration)
    await sql`update vat_returns set kz50 = 0, computed = computed - 'kz50', status = 'sent', sent_at = now() where id = ${entwurf.id}`;

    expect(await vat.gesendeteAbweichungen([2026])).toEqual([]);
  });
});
