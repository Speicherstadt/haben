import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { kleinunternehmerStand } from "../auswertungen/test-umsatz-stand.ts";

/*
 * Umsätze als Kleinunternehmer in Kz 48 (#1268): Die Anleitung zur UStVA 2026 nennt unter Kz 48 die Umsätze nach § 19
 * Abs. 1 UStG und ordnet den Gesamtbetrag dem Voranmeldungszeitraum der Leistungsausführung zu, Anzahlungen ausgenommen,
 * ohne Ausnahme für die Ist-Versteuerung. Gesendete Voranmeldungen ohne diese Umsätze bleiben, wie sie sind.
 */
describe.skipIf(!testDatabaseUrl)("Kleinunternehmer-Umsätze in Kz 48 (Postgres)", () => {
  let vat: typeof import("./index.ts");
  let bank: typeof import("../bank/index.ts");
  let invoices: typeof import("../rechnungen/index.ts");
  let contacts: typeof import("../stammdaten/contacts.ts");
  let cash: typeof import("../bank/cash-income.ts");
  let sql: postgres.Sql;
  const actor = "kz48-ku-test";
  const september = { year: 2026, month: 9 };
  const oktober = { year: 2026, month: 10 };
  const november = { year: 2026, month: 11 };
  let contactId: string;
  let nummer = 0;

  beforeAll(async () => {
    sql = await setupTestDb();
    vat = await import("./index.ts");
    bank = await import("../bank/index.ts");
    invoices = await import("../rechnungen/index.ts");
    contacts = await import("../stammdaten/contacts.ts");
    cash = await import("../bank/cash-income.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function firma(kontenrahmen: "SKR03" | "SKR04", versteuerung: "ist" | "soll") {
    await leeren(sql)`truncate vat_return_submissions, vat_returns, write_offs, allocations, bank_transactions, bank_imports,
      bank_accounts, cash_entries, journal_lines, journal_entries, invoice_lines, invoice_taxes, invoices, invoice_number_counters,
      contact_versions, contacts, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, telefon, steuernummer, ust_id, bundesland, iban, versteuerung,
        kontenrahmen, kleinunternehmer)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '+49 941 1', '198/113/10010',
              '', 'BY', 'DE89370400440532013000', ${versteuerung}, ${kontenrahmen}, true)`;
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
    contactId = contact.id;
  }

  /** Rechnung als Kleinunternehmer vom 03.10.2026 über 800,00 € für eine Leistung im September */
  async function rechnung() {
    const draft = await invoices.createDraft(actor, {
      contactId,
      issueDate: "2026-10-03",
      serviceFrom: "2026-09-01",
      serviceTo: "2026-09-30",
      paymentTermDays: 14,
      format: "zugferd",
      note: "",
      taxTreatment: "kleinunternehmer",
      lines: [{ description: "Webdesign", quantity: 1000, unit: "Psch.", unitPrice: 80_000, taxRate: 0 }],
    });
    return invoices.finalizeInvoice(actor, draft.id, kleinunternehmerStand);
  }

  /** Festgeschriebene Rechnung direkt in der Datenbank, für Anzahlung, Schlussrechnung und Storno */
  async function direkt(werte: Record<string, unknown>, net: number, abzuege: { von: string; net: number }[] = []) {
    const [row] = await sql`insert into invoices ${sql({
      contact_id: contactId,
      tax_treatment: "kleinunternehmer",
      due_date: "2026-12-31",
      net,
      tax: 0,
      gross: net,
      ...werte,
    } as Record<string, string | number | null>)} returning id, kind`;
    await sql`insert into invoice_taxes (invoice_id, rate, base, tax) values (${row!.id}, 0, ${net}, 0)`;
    let position = 0;
    for (const a of abzuege)
      await sql`insert into invoice_lines (invoice_id, position, description, quantity, unit, unit_price, tax_rate, net, deduction_of)
        values (${row!.id}, ${position++}, 'Abzug', 1000, 'Psch.', ${a.net}, 0, ${a.net}, ${a.von})`;
    await sql`update invoices set status = 'final', number = ${`KU-${++nummer}`}, locked_at = now()
      ${row!.kind === "rechnung" ? sql`` : sql`, reduction_rule = 'rueckgewaehr'`} where id = ${row!.id}`;
    return row!.id as string;
  }

  for (const kontenrahmen of ["SKR03", "SKR04"] as const)
    for (const versteuerung of ["ist", "soll"] as const) {
      it(`${kontenrahmen}/${versteuerung}: Kz 48 im Monat der Leistung, nicht der Rechnung oder Zahlung`, async () => {
        await firma(kontenrahmen, versteuerung);
        const inv = await rechnung();
        const csv = `"Girokonto";"DE89370400440532013000"\n\n"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"\n"05.11.26";"05.11.26";"Gebucht";"Nordwerk";"Testfirma";"${inv.number}";"Eingang";"DE02100100100006820101";"800,00";"";"";""\n`;
        await bank.importStatement(actor, { bytes: new TextEncoder().encode(csv), filename: `${inv.number}.csv` }, null);
        const [tx] = await sql`select id from bank_transactions where purpose = ${inv.number}`;
        await bank.allocate(actor, { kind: "invoice", transactionId: tx!.id, invoiceId: inv.id, amount: 80_000 });

        expect(await vat.computeVatFigures(september)).toMatchObject({ kz48: 80_000, kz48Kleinunternehmer: 80_000 });
        expect((await vat.computeVatFigures(oktober)).kz48).toBe(0);
        expect((await vat.computeVatFigures(november)).kz48).toBe(0);
        const entwurf = await vat.saveDraft(actor, september, { mode: "berechnet" });
        expect(entwurf.kz48).toBe(80_000);
        expect(new TextDecoder("latin1").decode((await vat.meinElsterUpload(entwurf.id)).bytes)).toContain("<Kz48>800</Kz48>");
      });
    }

  for (const [kontenrahmen, versteuerung] of [
    ["SKR04", "ist"],
    ["SKR03", "soll"],
  ] as const)
    it(`${kontenrahmen}/${versteuerung}: Bareinnahme und direkt gebuchte Erlöse ohne Rechnung zählen am Tag der Zahlung`, async () => {
      // Ohne Rechnung kennt Haben keinen anderen Tag (bareinnahme.ts, direkt-kategorie.ts); auch das sind Umsätze nach § 19 Abs. 1 UStG
      await firma(kontenrahmen, versteuerung);
      await cash.createCashIncome(
        actor,
        { date: "2026-10-12", amount: 20_000, text: "Markt", steuer: { behandlung: "kleinunternehmer", steuersatz: 0 } },
        "2026-11-23",
      );
      const csv = `"Girokonto";"DE89370400440532013000"\n\n"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"\n"15.10.26";"15.10.26";"Gebucht";"Privatkunde";"Testfirma";"Reparatur";"Eingang";"DE02100100100006820101";"150,00";"";"";""\n`;
      await bank.importStatement(actor, { bytes: new TextEncoder().encode(csv), filename: "direkt.csv" }, null);
      const [tx] = await sql`select id from bank_transactions where purpose = 'Reparatur'`;
      await bank.allocate(actor, { kind: "kategorie", transactionId: tx!.id, amount: 15_000, kategorie: { kategorie: "erloese", steuersatz: 0 } });

      const figures = await vat.computeVatFigures(oktober);
      expect(figures).toMatchObject({ kz48: 35_000, kz48Kleinunternehmer: 35_000 });
      expect(figures.kleinunternehmerUmsaetze.map((r) => [r.type, r.base])).toEqual([
        ["direkt", 15_000],
        ["kasse", 20_000],
      ]);
    });

  it("Storno zählt im Monat des Stornos, mit umgekehrtem Vorzeichen", async () => {
    await firma("SKR03", "ist");
    const original = await direkt({ issue_date: "2026-09-10", service_date: "2026-09-10" }, 50_000);
    await direkt({ kind: "storno", corrects_id: original, issue_date: "2026-11-02" }, -50_000);

    expect((await vat.computeVatFigures(september)).kz48).toBe(50_000);
    expect((await vat.computeVatFigures(november)).kz48Kleinunternehmer).toBe(-50_000);
  });

  it("Anzahlung zählt nicht, die Schlussrechnung mit der ganzen Leistung im Monat der Leistung", async () => {
    await firma("SKR04", "soll");
    const anzahlung = await direkt({ variant: "abschlag", advance_type: "anzahlung", issue_date: "2026-09-05" }, 30_000);
    await direkt({ variant: "schluss", issue_date: "2026-11-04", service_from: "2026-10-01", service_to: "2026-10-31", service_date: "2026-10-31" }, 70_000, [
      { von: anzahlung, net: -30_000 },
    ]);

    expect((await vat.computeVatFigures(september)).kz48).toBe(0);
    expect(await vat.computeVatFigures(oktober)).toMatchObject({ kz48: 100_000, kz48Kleinunternehmer: 100_000 });
    expect((await vat.computeVatFigures(november)).kz48).toBe(0);
  });

  it("Storno der Korrektur einer Anzahlung zählt nicht", async () => {
    // cancelInvoice storniert jede Korrektur für sich: Das Storno verweist auf die Korrektur, nicht auf die Anzahlung
    await firma("SKR03", "ist");
    const anzahlung = await direkt({ variant: "abschlag", advance_type: "anzahlung", issue_date: "2026-09-05" }, 30_000);
    const korrektur = await direkt({ kind: "korrektur", corrects_id: anzahlung, issue_date: "2026-10-02" }, -5_000);
    await direkt({ kind: "storno", corrects_id: anzahlung, issue_date: "2026-11-03" }, -30_000);
    await direkt({ kind: "storno", corrects_id: korrektur, issue_date: "2026-11-03" }, 5_000);

    expect((await vat.computeVatFigures(oktober)).kz48).toBe(0);
    expect((await vat.computeVatFigures(november)).kz48).toBe(0);
  });

  it("Teilleistung zählt im eigenen Monat, die Schlussrechnung nur mit dem Rest", async () => {
    await firma("SKR03", "soll");
    const teil = await direkt(
      { variant: "abschlag", advance_type: "teilleistung", issue_date: "2026-09-20", service_to: "2026-09-15", service_date: "2026-09-15" },
      30_000,
    );
    await direkt({ variant: "schluss", issue_date: "2026-10-28", service_date: "2026-10-28" }, 70_000, [{ von: teil, net: -30_000 }]);

    expect((await vat.computeVatFigures(september)).kz48).toBe(30_000);
    expect((await vat.computeVatFigures(oktober)).kz48).toBe(70_000);
  });

  it("Gesendete Voranmeldung von vor #1268 meldet keine Abweichung, ein anderer Wert schon", async () => {
    await firma("SKR03", "soll");
    await rechnung();
    const entwurf = await vat.saveDraft(actor, september, { mode: "berechnet" });
    // So steht eine früher gesendete Anmeldung da: Kz 48 ohne die Umsätze als Kleinunternehmer
    await sql`update vat_returns set kz48 = 0, status = 'sent', sent_at = now() where id = ${entwurf.id}`;
    expect(await vat.gesendeteAbweichungen([2026])).toEqual([]);

    await sql`update vat_returns set kz48 = 12300 where id = ${entwurf.id}`;
    expect(await vat.gesendeteAbweichungen([2026])).toEqual([{ period: september, feld: "Kz 48", gesendet: 12_300, journal: 80_000 }]);
  });
});
