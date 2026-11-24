import { EricGeprueftClient } from "../../test-eric.ts";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { kleinunternehmerStand } from "../auswertungen/test-umsatz-stand.ts";

/*
 * Forderungsausfall in der Umsatzsteuererklärung (#1809): Die Minderung der Bemessungsgrundlage für uneinbringliche
 * Forderungsentgelte steht zusätzlich in E3106101 (Kz 650; Zeile 78 im Vordruck 2025, „in Abschnitt B enthalten“), als
 * Summe der Kz 50 der Monate aus denselben Journalzeilen. Die Umsätze zu 19 und 7 % bleiben, wie sie sind (Anleitung zur
 * Umsatzsteuererklärung 2026, Zeile 84: „bitte zusätzlich“).
 */
describe.skipIf(!testDatabaseUrl)("Forderungsausfall in E3106101 (Postgres)", () => {
  let annual: typeof import("./annual.ts");
  let pruefen: typeof import("./erklaert-pruefen.ts");
  let vat: typeof import("../umsatzsteuer/index.ts");
  let bank: typeof import("../bank/index.ts");
  let invoices: typeof import("../rechnungen/index.ts");
  let contacts: typeof import("../stammdaten/contacts.ts");
  let sql: postgres.Sql;
  const actor = "e3106101-test";
  const TODAY = "2026-03-02";

  beforeAll(async () => {
    sql = await setupTestDb();
    annual = await import("./annual.ts");
    pruefen = await import("./erklaert-pruefen.ts");
    vat = await import("../umsatzsteuer/index.ts");
    bank = await import("../bank/index.ts");
    invoices = await import("../rechnungen/index.ts");
    contacts = await import("../stammdaten/contacts.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function firma(kontenrahmen: "SKR03" | "SKR04", versteuerung: "ist" | "soll") {
    await leeren(sql)`truncate annual_submissions, vat_return_submissions, vat_returns, vat_frequencies, write_offs, allocations,
      bank_transactions, bank_imports, bank_accounts, journal_lines, journal_entries, invoice_lines, invoices, invoice_number_counters,
      contact_versions, contacts, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, telefon, steuernummer, ust_id, bundesland, iban, versteuerung, kontenrahmen,
              einkunftsart, taetigkeit, kleinunternehmer)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '+49 941 1', '198/113/10010',
              'DE123456789', 'BY', 'DE89370400440532013000', ${versteuerung}, ${kontenrahmen}, 'selbstaendig', 'Softwareentwicklung', false)`;
  }

  /** Rechnung vom 20.09.2025: 1.000,00 € zu 19 % und 500,00 € zu 7 %, brutto 1.725,00 € */
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
      issueDate: "2025-09-20",
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

  const forderungsausfall = async (invoiceId: string, date: string) => bank.writeOff(actor, { kind: "forderungsausfall", invoiceId, date });

  /** Prüft die Erklärung über den Fake-Client (mit ERiC, wo vorhanden) und gibt das gespeicherte XML und die Werte zurück */
  async function geprueft() {
    const result = await annual.submitAnnual(actor, "ust", 2025, new EricGeprueftClient(), { kind: "validate", today: TODAY });
    expect(result.ok).toBe(true);
    const [row] = await sql`select request_xml, figures from annual_submissions where form = 'ust' order by created_at desc limit 1`;
    return { xml: row!.request_xml as string, figures: row!.figures as Record<string, unknown> };
  }

  const kz50DerMonate = async () => {
    const monate = await Promise.all(Array.from({ length: 12 }, (_, i) => vat.computeVatFigures({ year: 2025, month: i + 1 })));
    return monate.reduce((s, m) => s + m.kz50, 0);
  };

  for (const kontenrahmen of ["SKR03", "SKR04"] as const) {
    it(`Soll (${kontenrahmen}): E3106101 ist die Summe der Kz 50, die Umsätze zu 19 und 7 % bleiben gemindert wie bisher`, async () => {
      await firma(kontenrahmen, "soll");
      const ausgefallen = await rechnung();
      await rechnung();
      await forderungsausfall(ausgefallen.id, "2025-10-05");

      const ust = await annual.ustYear(2025);
      expect(await kz50DerMonate()).toBe(150_000);
      expect(ust.figures).toMatchObject({ base19: 100_000, tax19: 19_000, base7: 50_000, tax7: 3_500, kz50: 150_000 });
      const { xml, figures } = await geprueft();
      expect(xml).toContain("<E3106101>1500</E3106101>");
      expect(xml).toContain("<E3003303>1000</E3003303>");
      expect(xml).toContain("<E3004401>500</E3004401>");
      expect(figures.kz50).toBe(150_000);
    });
  }

  it("Ist (SKR03): ein Forderungsausfall ohne Zahlung war nie angemeldet, keine Minderung", async () => {
    await firma("SKR03", "ist");
    const inv = await rechnung();
    await forderungsausfall(inv.id, "2025-10-05");

    expect((await annual.ustYear(2025)).figures.kz50).toBe(0);
  });

  it("Soll (SKR04): heben sich Rechnung und Forderungsausfall im Jahr auf, steht die Zeile zu 19 % mit 0 da", async () => {
    await firma("SKR04", "soll");
    const inv = await rechnung();
    await forderungsausfall(inv.id, "2025-10-05");

    expect((await annual.ustYear(2025)).figures).toMatchObject({ base19: 0, base7: 0, kz50: 150_000 });
    const { xml } = await geprueft();
    expect(xml).toContain("<E3003303>0</E3003303>");
    expect(xml).toContain("<E3106101>1500</E3106101>");
  });

  it("Soll (SKR03): der Wiedereingang in einem späteren Monat mindert die Summe nicht, wie Kz 50 im Monat", async () => {
    await firma("SKR03", "soll");
    const inv = await rechnung();
    await rechnung();
    await forderungsausfall(inv.id, "2025-10-05");
    const [w] = await bank.listWriteOffs({ invoiceId: inv.id });
    await bank.reverseWriteOff(actor, w!.id, "2025-11-03");

    expect((await annual.ustYear(2025)).figures).toMatchObject({ base19: 200_000, base7: 100_000, kz50: 150_000 });
  });

  it("Soll (SKR04), vierteljährlich: Ausfall und Wiedereingang im selben Quartal heben sich auf, wie in Kz 50 des Quartals", async () => {
    await firma("SKR04", "soll");
    await sql`insert into vat_frequencies (year, from_month, frequency) values (2025, 1, 'vierteljaehrlich')`;
    const inv = await rechnung();
    await rechnung();
    await forderungsausfall(inv.id, "2025-10-05");
    const [w] = await bank.listWriteOffs({ invoiceId: inv.id });
    await bank.reverseWriteOff(actor, w!.id, "2025-11-03");

    // Die Voranmeldung für das 4. Quartal meldet keine Kz 50; die Summe der Voranmeldungen des Jahres ist 0
    expect((await vat.computeVatFigures({ year: 2025, month: 44 })).kz50).toBe(0);
    expect((await annual.ustYear(2025)).figures).toMatchObject({ base19: 200_000, base7: 100_000, kz50: 0 });
  });

  it("Abgleich: Kz 650 zählt nur, wenn die übermittelte Erklärung sie festhält", async () => {
    await firma("SKR04", "soll");
    const inv = await rechnung();
    await rechnung();
    await forderungsausfall(inv.id, "2025-10-05");
    const { figures } = await geprueft();
    const uebermittelt = async (werte: Record<string, unknown>) => {
      await leeren(sql)`truncate annual_submissions cascade`;
      await sql`insert into annual_submissions (form, year, kind, ok, code, message, figures, request_xml, response_xml, server_response_xml)
        values ('ust', 2025, 'send', true, 0, 'ok', ${JSON.stringify(werte)}::jsonb, '', '', '')`;
      return pruefen.erklaerteAbweichungen([2025]);
    };

    // Vor #1809 übermittelt: ohne kz50, keine Abweichung
    const { kz50: _, ...ohneKz50 } = figures;
    expect(await uebermittelt(ohneKz50)).toEqual([]);
    expect(await uebermittelt(figures)).toEqual([]);
    // Mit festgehaltener Kz 650, die heute anders gerechnet wird
    expect(await uebermittelt({ ...figures, kz50: 100_000 })).toEqual([
      { year: 2025, form: "ust", art: "übermittelt", feld: "kz50", erklaert: 100_000, journal: 150_000 },
    ]);
  });
});
