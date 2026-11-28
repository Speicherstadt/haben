import { ACCOUNTS } from "@haben/core";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { kleinunternehmerStand } from "../auswertungen/test-umsatz-stand.ts";

/**
 * #2079: Die Steuer einer Rechnungskorrektur ist die Differenz der Gesamtstände je Satz (Rechnung und festgeschriebene
 * Korrekturen), gerundet wird nur der Stand. Mehrere Korrekturen nehmen so zusammen genau die Steuer der Rechnung zurück.
 */
describe.skipIf(!testDatabaseUrl)("Steuer der Korrektur aus dem Gesamtstand (Postgres)", () => {
  let sql: postgres.Sql;
  let invoices: typeof import("./index.ts");
  let bank: typeof import("../bank/index.ts");
  let contacts: typeof import("../stammdaten/index.ts");
  let vat: typeof import("../umsatzsteuer/index.ts");
  let reports: typeof import("../auswertungen/index.ts");
  let accounting: typeof import("../buchhaltung/index.ts");
  let contactId: string;
  const actor = "korrektur-gesamtstand-test";
  const iban = "DE89370400440532013000";

  beforeAll(async () => {
    sql = await setupTestDb();
    invoices = await import("./index.ts");
    bank = await import("../bank/index.ts");
    contacts = await import("../stammdaten/index.ts");
    vat = await import("../umsatzsteuer/index.ts");
    reports = await import("../auswertungen/index.ts");
    accounting = await import("../buchhaltung/index.ts");
  });
  afterAll(async () => {
    await sql?.end();
  });
  beforeEach(async () => {
    await leeren(sql)`truncate seals, audit_log, company, invoices, invoice_number_counters, contacts, journal_entries,
      allocations, write_offs, bank_transactions, bank_imports, bank_accounts, invoice_settlements, exchange_rates cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, telefon, steuernummer, ust_id, bundesland, iban,
      kontenrahmen, versteuerung)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '0941 1',
      '198/113/10010', 'DE123456789', 'BY', ${iban}, 'SKR03', 'soll')`;
    contactId = (
      await contacts.createContact(actor, {
        kundennummer: "",
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
      })
    ).id;
  });

  type Line = { description: string; quantity: number; unit: string; unitPrice: number; taxRate: 0 | 700 | 1900 };
  const beratung = (unitPrice: number, taxRate: Line["taxRate"] = 1900): Line => ({
    description: "Beratung",
    quantity: 1000,
    unit: "Psch.",
    unitPrice,
    taxRate,
  });
  /**
   * Position zu 7 %, die keine Korrektur berührt: Korrekturen, die die ganze unbezahlte Rechnung aufheben, weist Haben
   * seit #2037 als Storno ab. Der Satz 19 % geht so weiter genau auf 0, ohne dass die Rechnung aufgehoben ist.
   */
  const bleibt = (priceMode: "netto" | "brutto" = "netto") => beratung(priceMode === "netto" ? 1_000 : 1_070, 700);
  type Extra = Partial<Parameters<typeof invoices.createDraft>[1]>;
  const fields = (issueDate: string, lines: Line[], extra: Extra = {}) => ({
    contactId,
    issueDate,
    serviceFrom: null,
    serviceTo: null,
    paymentTermDays: 14,
    format: "xrechnung-cii" as const,
    note: "",
    lines,
    ...extra,
  });

  async function invoice(lines: Line[], extra: Extra = {}, issueDate = "2026-05-05") {
    const draft = await invoices.createDraft(actor, fields(issueDate, lines, extra));
    return invoices.finalizeInvoice(actor, draft.id, kleinunternehmerStand);
  }

  async function correctionDraft(originalId: string, date: string, lines: Line[], extra: Extra = {}) {
    const draft = await invoices.createCorrection(actor, originalId, date);
    return invoices.updateDraft(actor, draft.id, { ...fields(date, lines, extra), paymentTermDays: 0 });
  }

  const correction = async (originalId: string, date: string, lines: Line[], extra: Extra = {}) =>
    invoices.finalizeInvoice(actor, (await correctionDraft(originalId, date, lines, extra)).id, kleinunternehmerStand);

  const storedTaxes = async (invoiceId: string) =>
    (await sql`select rate, base, tax, original_base::int, original_tax::int from invoice_taxes where invoice_id = ${invoiceId} and rate = 1900`).map((r) => ({
      ...r,
    }));

  async function pay(invoiceId: string, date: string, amount: number) {
    const germanDate = `${date.slice(8)}.${date.slice(5, 7)}.${date.slice(2, 4)}`;
    const purpose = `Zahlung ${invoiceId} ${date} ${amount}`;
    const abs = Math.abs(amount);
    const euros = `${amount < 0 ? "-" : ""}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
    const csv =
      `"Girokonto";"${iban}"\n\n` +
      `"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"\n` +
      `"${germanDate}";"${germanDate}";"Gebucht";"Nordwerk Software GmbH";"Testfirma";"${purpose}";"Überweisung";"DE02120300000000202051";"${euros}";"";"";""\n`;
    await bank.importStatement(actor, { bytes: new TextEncoder().encode(csv), filename: `${date}-${amount}.csv` }, null);
    const [transaction] = await sql`select id from bank_transactions where purpose = ${purpose}`;
    await bank.allocate(actor, { kind: "invoice", transactionId: transaction!.id, invoiceId, amount });
  }

  async function kz(month: number) {
    const f = await vat.computeVatFigures({ year: 2026, month });
    expect.soft((await reports.vatAbgleich({ year: 2026, month })).zeilen.filter((row) => row.journal !== row.quelle)).toEqual([]);
    return { kz81: f.kz81, tax81: f.tax81 };
  }

  async function balance(account: string) {
    const rows = await accounting.saldenliste({ from: "2026-01-01", to: "2026-12-31" });
    return rows.find((row) => row.account === account)?.saldo ?? 0;
  }

  async function integrity() {
    expect((await reports.checkIntegrity("2027-01-01")).abgleich.abweichungen).toEqual([]);
    expect(await sql`select * from haben_integrity_problems(100)`).toEqual([]);
  }

  for (const frame of ["SKR03", "SKR04"] as const)
    it(`${frame}, Soll: 100,00 € mit −0,50 € und −99,50 € nehmen genau 19,00 € zurück, gemeldet im Monat der Änderung`, async () => {
      await sql`update company set kontenrahmen = ${frame}`;
      const original = await invoice([beratung(10_000), bleibt()]);
      const a = await correction(original.id, "2026-06-10", [beratung(-50)]);
      expect(a).toMatchObject({ net: -50, tax: -9, gross: -59 });
      // PDF und XML zeigen die Steuer, die gebucht wird
      expect(a.xml).toContain("<ram:CalculatedAmount>0.09</ram:CalculatedAmount>");
      expect(a.xml).toContain("<ram:GrandTotalAmount>0.59</ram:GrandTotalAmount>");
      const b = await correction(original.id, "2026-07-10", [beratung(-9_950)]);
      expect(b).toMatchObject({ net: -9_950, tax: -1_891, gross: -11_841 });
      expect(await kz(5)).toEqual({ kz81: 10_000, tax81: 1_900 });
      expect(await kz(6)).toEqual({ kz81: -50, tax81: -9 });
      expect(await kz(7)).toEqual({ kz81: -9_950, tax81: -1_891 });
      expect(await balance(ACCOUNTS[frame].ust[1900])).toBe(0);
      expect(await balance(ACCOUNTS[frame].forderungen)).toBe(1_070);
      await integrity();
    }, 40_000);

  it("SKR03, Ist: Rechnung bezahlt, die Korrekturen mindern mit den Erstattungen genau um die Steuer der Rechnung", async () => {
    await sql`update company set versteuerung = 'ist'`;
    // Bezahlt: hier dürfen die Korrekturen die ganze Rechnung aufheben (#2037)
    const original = await invoice([beratung(10_000)]);
    await pay(original.id, "2026-05-20", 11_900);
    const a = await correction(original.id, "2026-06-10", [beratung(-50)]);
    await pay(a.id, "2026-06-15", -59);
    const b = await correction(original.id, "2026-07-10", [beratung(-9_950)]);
    await pay(b.id, "2026-08-14", -11_841);
    expect(await kz(5)).toEqual({ kz81: 10_000, tax81: 1_900 });
    expect(await kz(6)).toEqual({ kz81: -50, tax81: -9 });
    expect(await kz(7)).toEqual({ kz81: 0, tax81: 0 });
    expect(await kz(8)).toEqual({ kz81: -9_950, tax81: -1_891 });
    expect(await balance(ACCOUNTS.SKR03.ust[1900])).toBe(0);
    await integrity();
  }, 40_000);

  it("1,03 € mit −0,34 €, −0,34 € und −0,35 €: brutto bleibt nichts offen", async () => {
    const original = await invoice([beratung(103), bleibt()]);
    expect(original).toMatchObject({ tax: 20 + 70, gross: 123 + 1_070 });
    const parts = [];
    for (const [net, date] of [
      [-34, "2026-06-01"],
      [-34, "2026-06-02"],
      [-35, "2026-06-03"],
    ] as const)
      parts.push(await correction(original.id, date, [beratung(net)]));
    expect(parts.map((p) => p.tax)).toEqual([-7, -6, -7]);
    expect(original.gross + parts.reduce((s, p) => s + p.gross, 0)).toBe(1_070);
    expect(await balance(ACCOUNTS.SKR03.forderungen)).toBe(1_070);
    await integrity();
  }, 40_000);

  it("ein Entwurf, der vor einer anderen Korrektur gespeichert wurde, rechnet beim Festschreiben auf deren Stand", async () => {
    const original = await invoice([beratung(10_000), bleibt()]);
    const later = await correctionDraft(original.id, "2026-06-10", [beratung(-9_950)]);
    // Auf dem Stand der Rechnung gespeichert: 0,50 € → 0,10 € (0,095), also −18,90 €
    expect(later).toMatchObject({ net: -9_950, tax: -1_890 });
    await correction(original.id, "2026-06-09", [beratung(-50)]);
    // Festgeschrieben auf dem Stand nach −0,50 € (99,50 € mit 18,91 € Steuer): −18,91 €
    const final = await invoices.finalizeInvoice(actor, later.id, kleinunternehmerStand);
    expect(final).toMatchObject({ net: -9_950, tax: -1_891, gross: -11_841 });
    expect(await storedTaxes(final.id)).toEqual([{ rate: 1900, base: -9_950, tax: -1_891, original_base: null, original_tax: null }]);

    // Umgekehrt: −0,50 € zuerst gespeichert (−0,09 € auf dem Stand der Rechnung), dann −99,50 € festgeschrieben
    const second = await invoice([beratung(10_000), bleibt()]);
    const small = await correctionDraft(second.id, "2026-06-10", [beratung(-50)]);
    expect(small).toMatchObject({ tax: -9 });
    await correction(second.id, "2026-06-09", [beratung(-9_950)]);
    // Stand 0,50 € → 0,10 € (0,095), die Korrektur nimmt die restlichen 0,10 € zurück
    expect(await invoices.finalizeInvoice(actor, small.id, kleinunternehmerStand)).toMatchObject({ net: -50, tax: -10, gross: -60 });
    await integrity();
  }, 40_000);

  it("eine einzelne Korrektur ohne Rundung dazwischen rechnet wie bisher, zwei Sätze je für sich", async () => {
    const original = await invoice([beratung(10_000), beratung(20_000, 700)]);
    const k = await correction(original.id, "2026-06-10", [beratung(-2_000), beratung(-4_000, 700)]);
    expect(k).toMatchObject({ net: -6_000, tax: -380 - 280, gross: -6_660 });
  }, 30_000);

  it("Storno nach mehreren Korrekturen hebt alles auf den Cent auf, je Beleg genau negiert", async () => {
    const original = await invoice([beratung(10_000), bleibt()]);
    const a = await correction(original.id, "2026-06-10", [beratung(-50)]);
    await correction(original.id, "2026-06-11", [beratung(-50)]);
    await invoices.cancelInvoice(actor, original.id, "2026-06-20");
    const stornoOfA = await sql`select net, tax, gross from invoices where kind = 'storno' and corrects_id = ${a.id}`;
    expect(stornoOfA.map((r) => ({ ...r }))).toEqual([{ net: 50, tax: 9, gross: 59 }]);
    const [sum] = await sql`select sum(net)::int as net, sum(tax)::int as tax, sum(gross)::int as gross from invoices where status = 'final'`;
    expect({ ...sum }).toEqual({ net: 0, tax: 0, gross: 0 });
    expect(await kz(6)).toEqual({ kz81: -10_000, tax81: -1_900 });
    await integrity();
  }, 40_000);

  it("Bruttopreise: Steuer aus dem Gesamtstand brutto, Zeilennetto ergibt die Bemessungsgrundlage", async () => {
    // 1,01 € brutto: 0,85 € netto, 0,16 € Steuer
    const original = await invoice([beratung(101), bleibt("brutto")], { priceMode: "brutto" });
    expect(original).toMatchObject({ net: 85 + 1_000, tax: 16 + 70, gross: 101 + 1_070 });
    // −0,10 € brutto für sich: −0,02 € Steuer; Stand danach 0,91 € mit 0,15 € Steuer, also −0,01 €
    const a = await correction(original.id, "2026-06-10", [beratung(-4), beratung(-6)], { priceMode: "brutto" });
    expect(a).toMatchObject({ priceMode: "brutto", net: -9, tax: -1, gross: -10 });
    const lines = await sql`select net from invoice_lines where invoice_id = ${a.id} order by position`;
    expect(lines.map((l) => l.net)).toEqual([-3, -6]);
    expect(a.xml).toContain("<ram:LineTotalAmount>0.06</ram:LineTotalAmount>");
    const b = await correction(original.id, "2026-06-11", [beratung(-91)], { priceMode: "brutto" });
    expect(b).toMatchObject({ net: -76, tax: -15, gross: -91 });
    await integrity();
  }, 40_000);

  it("Gesamtrabatt: die Steuer folgt aus der Bemessungsgrundlage nach Rabatt", async () => {
    // 2,02 € abzüglich 50 %: 1,01 € netto, 0,19 € Steuer
    const original = await invoice([beratung(202), bleibt()], { discount: { kind: "prozent", value: 5000 } });
    expect(original).toMatchObject({ net: 101 + 500, tax: 19 + 35 });
    // −1,00 € abzüglich 50 %: −0,50 €; Stand 0,51 € → 0,10 €, also −0,09 € statt −0,10 €
    const discount = { discount: { kind: "prozent" as const, value: 5000 } };
    const a = await correction(original.id, "2026-06-10", [beratung(-100)], discount);
    expect(a).toMatchObject({ net: -50, tax: -9, gross: -59 });
    const b = await correction(original.id, "2026-06-11", [beratung(-102)], discount);
    expect(b).toMatchObject({ net: -51, tax: -10 });
    await integrity();
  }, 40_000);

  it("Schlussrechnung: die Korrektur behält die Abzüge, die Steuer folgt aus dem Gesamtstand der Schlussrechnung", async () => {
    const abschlag = await invoice([beratung(5_000)], { variant: "abschlag" });
    const schluss = await invoice([beratung(10_000)], { variant: "schluss", deducts: [abschlag.id] });
    expect(schluss).toMatchObject({ net: 5_000, tax: 950 });
    // Leistung −50,50 € samt übernommenem Abzug +50,00 €: −0,50 €; Stand 49,50 € → 9,41 €, also −0,09 €
    const a = await correction(schluss.id, "2026-06-10", [beratung(-5_050)]);
    expect(a).toMatchObject({ net: -50, tax: -9, gross: -59 });
    const lines = await sql`select unit_price, deduction_of from invoice_lines where invoice_id = ${a.id} order by position`;
    expect(lines.map((l) => [l.unit_price, l.deduction_of])).toEqual([
      [-5_050, null],
      [5_000, abschlag.id],
    ]);
    const b = await correction(schluss.id, "2026-06-11", [beratung(-9_950)]);
    expect(b).toMatchObject({ net: -4_950, tax: -941 });
    expect(a.tax + b.tax).toBe(-950);
    await integrity();
  }, 40_000);

  it("Fremdwährung: Gesamtstand in der Währung der Rechnung, in Euro je Beleg mit dem Kurs der Rechnung", async () => {
    const original = await invoice([beratung(10_000), bleibt()], { currency: "GBP", exchangeRate: "0,85" });
    expect(await storedTaxes(original.id)).toEqual([{ rate: 1900, base: 11_765, tax: 2_235, original_base: 10_000, original_tax: 1_900 }]);
    const a = await correction(original.id, "2026-06-10", [beratung(-50)]);
    // GBP: −0,09 (Stand 18,91); in Euro je Beleg umgerechnet wie bisher: −0,09 GBP = −0,11 €
    expect(await storedTaxes(a.id)).toEqual([{ rate: 1900, base: -59, tax: -11, original_base: -50, original_tax: -9 }]);
    expect(a.xml).toContain("<ram:CalculatedAmount>0.09</ram:CalculatedAmount>");
    const b = await correction(original.id, "2026-06-11", [beratung(-9_950)]);
    expect(await storedTaxes(b.id)).toEqual([{ rate: 1900, base: -11_706, tax: -2_225, original_base: -9_950, original_tax: -1_891 }]);
    // In GBP genau aufgehoben; in Euro bleibt die Rundung je Beleg: 22,35 € gebucht, 22,36 € zurück (je Beleg vorher 22,37 €)
    expect(await kz(6)).toEqual({ kz81: -11_765, tax81: -2_236 });
    expect(await balance(ACCOUNTS.SKR03.ust[1900])).toBe(1);
    await integrity();
  }, 40_000);
});
