import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { kleinunternehmerStand } from "../auswertungen/test-umsatz-stand.ts";

/*
 * Skonto nach einer Korrektur bei gemischten Steuersätzen (#1586): Das Skonto mindert die Entgelte, die nach der Korrektur
 * übrig sind (§ 17 Abs. 1 Satz 1 UStG), nicht den Mix der Rechnung. Beispiel aus dem Issue: Rechnung 100,00 € netto zu 7 %
 * und 100,00 € zu 19 % (226,00 €), Korrektur −50,00 € netto nur zu 19 % (−59,50 €), offen 166,50 €, 2 % Skonto 3,33 €,
 * Zahlung 163,17 €. Rest-Mix 107,00 € zu 7 % und 59,50 € zu 19 %: Skonto 2,00 € + 0,14 € und 1,00 € + 0,19 €.
 */
describe.skipIf(!testDatabaseUrl)("Skonto nach Korrektur bei gemischten Steuersätzen (Postgres, #1586)", () => {
  let bank: typeof import("./index.ts");
  let invoices: typeof import("../rechnungen/index.ts");
  let contacts: typeof import("../stammdaten/contacts.ts");
  let vat: typeof import("../umsatzsteuer/vat-figures.ts");
  let sql: postgres.Sql;
  let contactId: string;
  const actor = "test-user";

  beforeAll(async () => {
    sql = await setupTestDb();
    bank = await import("./index.ts");
    invoices = await import("../rechnungen/index.ts");
    contacts = await import("../stammdaten/contacts.ts");
    vat = await import("../umsatzsteuer/vat-figures.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  /** Firma mit 2 % Skonto in 10 Tagen als Vorgabe, Zahlungsziel 14 Tage */
  async function firma(kontenrahmen: "SKR03" | "SKR04", versteuerung: "ist" | "soll") {
    await leeren(sql)`truncate write_offs, allocations, bank_transactions, bank_imports, bank_accounts, journal_lines, journal_entries,
      document_amounts, documents, invoice_lines, invoices, invoice_number_counters, contact_versions, contacts, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, telefon, steuernummer, ust_id, bundesland, iban, versteuerung, kontenrahmen,
                                   payment_term_days, skonto)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '+49 941 1', '198/113/10010',
              'DE123456789', 'BY', 'DE89370400440532013000', ${versteuerung}, ${kontenrahmen}, 14, ${JSON.stringify([{ days: 10, percent: 200 }])}::jsonb)`;
    const contact = await contacts.createContact(actor, {
      kundennummer: "10001",
      name: "Testkunde",
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
  }

  type Zeile = { unitPrice: number; taxRate: 1900 | 700 };
  async function beleg(zeilen: Zeile[], issueDate: string, korrigiert?: string) {
    const defaults = await invoices.newDraftDefaults(issueDate);
    const lines = zeilen.map((z) => ({ description: "Wartung", quantity: 1000, unit: "Psch.", ...z }));
    const entwurf = await invoices.createDraft(
      actor,
      { ...defaults, contactId, format: "zugferd", lines },
      korrigiert ? { kind: "korrektur", correctsId: korrigiert } : undefined,
    );
    return invoices.finalizeInvoice(actor, entwurf.id, kleinunternehmerStand);
  }

  /** Rechnung 100,00 € zu 7 % und 100,00 € zu 19 % vom 02.11.2026, dazu Korrekturen vom 05.11.2026 */
  async function rechnungMitKorrekturen(...korrekturen: Zeile[][]) {
    const rechnung = await beleg(
      [
        { unitPrice: 10_000, taxRate: 700 },
        { unitPrice: 10_000, taxRate: 1900 },
      ],
      "2026-11-02",
    );
    const ids = [];
    for (const zeilen of korrekturen) ids.push((await beleg(zeilen, "2026-11-05", rechnung.id)).id);
    return { rechnung, korrekturen: ids };
  }

  async function zahlung(betrag: string, zweck: string) {
    const head = '"Girokonto";"DE12 1203 0000 1234 5678 90"\n""\n"Kontostand vom 20.11.2026:";"163,17 €"\n""\n';
    const columns =
      '"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"\n';
    const row = ["06.11.26", "06.11.26", "Gebucht", "Testkunde", "Testfirma", zweck, "Eingang", "", betrag, "", "", ""];
    const bytes = new TextEncoder().encode(`﻿${head}${columns}${row.map((v) => `"${v}"`).join(";")}\n`);
    await bank.importStatement(actor, { bytes, filename: `${zweck}.csv` }, null);
    const [tx] = await sql`select id from bank_transactions where purpose = ${zweck}`;
    return tx!.id as string;
  }

  const offen = async (...ids: string[]) => (await bank.openItems()).filter((item) => ids.includes(item.id)).map((item) => [item.number, item.open]);
  const skontoAnteile = async () =>
    (
      await sql`select tax_shares from write_offs w where kind = 'skonto' and reverses_id is null and not exists (select 1 from write_offs r where r.reverses_id = w.id)`
    )
      .flatMap((r) => (r.tax_shares as { rate: number; base: number; tax: number }[]).map(({ rate, base, tax }) => ({ rate, base, tax })))
      .sort((a, b) => a.rate - b.rate);
  const salden = async () =>
    Object.fromEntries(
      (await sql`select account, sum(debit - credit)::int as saldo from journal_lines group by account having sum(debit - credit) <> 0`).map((r) => [
        r.account,
        r.saldo,
      ]),
    );

  async function mitSkontoBuchen(betrag: string, rechnungId: string, korrekturen: string[]) {
    const id = await zahlung(betrag, "Zahlung mit Skonto");
    await bank.allocateWithRest(actor, { transactionId: id, target: { kind: "invoice", invoiceId: rechnungId }, rest: "skonto", korrekturen });
    return id;
  }

  it.each([
    ["SKR03", "ist", { bank: "1200", ust7: "1771", ust19: "1776", erloese7: "8300", erloese19: "8400", skonto: "8730" }],
    ["SKR03", "soll", { bank: "1200", ust7: "1771", ust19: "1776", erloese7: "8300", erloese19: "8400", skonto: "8730" }],
    ["SKR04", "ist", { bank: "1800", ust7: "3801", ust19: "3806", erloese7: "4300", erloese19: "4400", skonto: "4730" }],
    ["SKR04", "soll", { bank: "1800", ust7: "3801", ust19: "3806", erloese7: "4300", erloese19: "4400", skonto: "4730" }],
  ] as const)(
    "Beispiel aus dem Issue: Vorschlag, Buchung und Voranmeldung nach den verbleibenden Entgelten (%s, %s)",
    async (kontenrahmen, versteuerung, konto) => {
      await firma(kontenrahmen, versteuerung);
      const { rechnung, korrekturen } = await rechnungMitKorrekturen([{ unitPrice: -5000, taxRate: 1900 }]);
      const item = (await bank.openItems()).find((i) => i.id === rechnung.id);
      expect(item?.skontoNachKorrektur).toMatchObject([{ percent: 200, amount: 333, payable: 16_317 }]);
      const id = await zahlung("163,17", `Rechnung ${rechnung.number}`);
      const [best] = (await bank.transactionDetail(id))!.suggestions;
      expect(best).toMatchObject({ item: { id: rechnung.id }, corrections: [{ id: korrekturen[0] }], skonto: 333 });

      await bank.allocateWithRest(actor, { transactionId: id, target: { kind: "invoice", invoiceId: rechnung.id }, rest: "skonto", korrekturen });
      expect(await offen(rechnung.id, ...korrekturen)).toEqual([]);
      expect(await skontoAnteile()).toEqual([
        { rate: 700, base: 200, tax: 14 },
        { rate: 1900, base: 100, tax: 19 },
      ]);
      // Erlöse 100,00 € (7 %) und 100,00 € − 50,00 € (19 %), Skonto 3,00 € netto, USt 7,00 € − 0,14 € und 19,00 € − 9,50 € − 0,19 €
      expect(await salden()).toEqual({
        [konto.bank]: 16_317,
        [konto.erloese7]: -10_000,
        [konto.erloese19]: -5000,
        [konto.ust7]: -686,
        [konto.ust19]: -931,
        [konto.skonto]: 300,
      });
      expect(await vat.computeVatFigures({ year: 2026, month: 11 })).toMatchObject({ kz86: 9800, tax86: 686, kz81: 4900, tax81: 931 });
    },
    60_000,
  );

  it("Korrektur auf beide Sätze und zwei Korrekturen auf verschiedene Sätze verteilen nach dem Rest", async () => {
    await firma("SKR03", "ist");
    // Korrektur −20,00 € (7 %) und −50,00 € (19 %): Rest 85,60 € zu 7 % und 59,50 € zu 19 % = 145,10 €, Skonto 2,90 €
    const beide = await rechnungMitKorrekturen([
      { unitPrice: -2000, taxRate: 700 },
      { unitPrice: -5000, taxRate: 1900 },
    ]);
    await mitSkontoBuchen("142,20", beide.rechnung.id, beide.korrekturen);
    const anteileBeide = await skontoAnteile();
    expect(anteileBeide.reduce((s, a) => s + a.base + a.tax, 0)).toBe(290);
    // 290 × 8560 / 14510 = 171,08 → 1,71 € zu 7 %, der Rest 1,19 € zu 19 %
    expect(anteileBeide).toEqual([
      { rate: 700, base: 160, tax: 11 },
      { rate: 1900, base: 100, tax: 19 },
    ]);

    // Dasselbe als zwei Korrekturen, je eine auf einen Satz
    await firma("SKR03", "ist");
    const zwei = await rechnungMitKorrekturen([{ unitPrice: -2000, taxRate: 700 }], [{ unitPrice: -5000, taxRate: 1900 }]);
    await mitSkontoBuchen("142,20", zwei.rechnung.id, zwei.korrekturen);
    expect(await skontoAnteile()).toEqual(anteileBeide);
    expect(await offen(zwei.rechnung.id, ...zwei.korrekturen)).toEqual([]);
  }, 60_000);

  // Ohne Prozentzeichen im Titel: Vitest füllt bei it.each auch „%%“ mit einem Wert (der Titel zeigte „undefined“)
  it.each(["ist", "soll"] as const)(
    "Korrektur hebt den Teil zu 19 Prozent ganz auf: Skonto nur auf 7 Prozent, 19 Prozent steht mit null im Anteil (%s)",
    async (versteuerung) => {
      await firma("SKR03", versteuerung);
      // Rest 107,00 € zu 7 %, 2 % Skonto 2,14 €, Zahlung 104,86 €
      const { rechnung, korrekturen } = await rechnungMitKorrekturen([{ unitPrice: -10_000, taxRate: 1900 }]);
      await mitSkontoBuchen("104,86", rechnung.id, korrekturen);
      expect(await offen(rechnung.id, ...korrekturen)).toEqual([]);
      // Die Null-Zeile hält den Anteil gültig: recordedTaxShares verlangt dieselben Sätze wie die Rechnung
      expect(await skontoAnteile()).toEqual([
        { rate: 700, base: 200, tax: 14 },
        { rate: 1900, base: 0, tax: 0 },
      ]);
      expect(await vat.computeVatFigures({ year: 2026, month: 11 })).toMatchObject({ kz86: 9800, tax86: 686, kz81: 0, tax81: 0 });
    },
    60_000,
  );

  it("„Aufheben“ hebt Aufteilung und Skonto zusammen auf, mit genau umgekehrten Anteilen", async () => {
    await firma("SKR03", "ist");
    const { rechnung, korrekturen } = await rechnungMitKorrekturen([{ unitPrice: -5000, taxRate: 1900 }]);
    await mitSkontoBuchen("163,17", rechnung.id, korrekturen);
    const [teil] = await sql`select id from allocations where invoice_id = ${korrekturen[0]!}`;
    await bank.reverseAllocation(actor, teil!.id, "2026-11-20");
    expect(await offen(rechnung.id, ...korrekturen)).toEqual([
      [rechnung.number, 22_600],
      [expect.any(String), -5950],
    ]);
    expect((await bank.listWriteOffs({ invoiceId: rechnung.id })).map((w) => w.reversed)).toEqual([true]);
    // Skonto und seine Steuerminderung sind ganz zurückgenommen, je Satz
    const s = await salden();
    expect([s["8730"], s["1771"], s["1776"]]).toEqual([undefined, undefined, undefined]);
  }, 60_000);
});
