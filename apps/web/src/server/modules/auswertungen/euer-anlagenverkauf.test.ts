import { ACCOUNTS, type Kontenrahmen, type TaxTreatment } from "@haben/core";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { kleinunternehmerStand } from "./test-umsatz-stand.ts";

/*
 * Verkauf einer Anlage per Rechnung (#2022): Eine Rechnung mit „Verkauf aus dem Anlagevermögen“ bucht auf „Erlöse aus
 * Verkäufen Sachanlagevermögen … (bei Buchgewinn)“ (DATEV-Kontenrahmen 2026) und zählt in der EÜR in Zeile 19
 * „Veräußerung oder Entnahme von Anlagevermögen“ (Anleitung zur EÜR 2025), mit der Zahlung (§ 11 EStG), auch bei
 * Soll-Versteuerung. Rechnungen von vor #2022 haben auf das normale Erlöskonto gebucht: Sie zählen nach dem gespeicherten
 * Kennzeichen, und Storno und Korrektur buchen auf die Konten der ursprünglichen Buchung.
 */
describe.skipIf(!testDatabaseUrl)("Verkauf einer Anlage per Rechnung in der EÜR (Postgres)", () => {
  let reports: typeof import("./reports.ts");
  let abgleich: typeof import("./abgleich.ts");
  let gesamtumsatz: typeof import("./gesamtumsatz.ts");
  let annual: typeof import("../jahreserklaerung/annual.ts");
  let invoices: typeof import("../rechnungen/index.ts");
  let contacts: typeof import("../stammdaten/contacts.ts");
  let cashInvoice: typeof import("../bank/cash-invoice.ts");
  let assets: typeof import("../buchhaltung/assets.ts");
  let buchhaltung: typeof import("../buchhaltung/index.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  let contactId: string;
  let kleinunternehmer = false;

  const VERKAUF: Record<Kontenrahmen, { ust19: string; ohneUst: string }> = {
    SKR03: { ust19: "8820", ohneUst: "8829" },
    SKR04: { ust19: "4845", ohneUst: "4849" },
  };

  beforeAll(async () => {
    sql = await setupTestDb();
    reports = await import("./reports.ts");
    abgleich = await import("./abgleich.ts");
    gesamtumsatz = await import("./gesamtumsatz.ts");
    annual = await import("../jahreserklaerung/annual.ts");
    invoices = await import("../rechnungen/index.ts");
    contacts = await import("../stammdaten/contacts.ts");
    cashInvoice = await import("../bank/cash-invoice.ts");
    assets = await import("../buchhaltung/assets.ts");
    buchhaltung = await import("../buchhaltung/index.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function reset(versteuerung: "ist" | "soll", kontenrahmen: Kontenrahmen, ku = false) {
    kleinunternehmer = ku;
    await leeren(sql)`truncate asset_depreciations, assets, allocations, bank_transactions, bank_imports, bank_accounts, cash_entries, write_offs,
      journal_lines, journal_entries, invoice_lines, invoices, invoice_number_counters, contact_versions, contacts, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, telefon, steuernummer, ust_id, bundesland, iban, versteuerung, kontenrahmen, kleinunternehmer)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '+49 941 1', '198/113/10010',
              'DE123456789', 'BY', 'DE89370400440532013000', ${versteuerung}, ${kontenrahmen}, ${ku})`;
    contactId = (
      await contacts.createContact(actor, {
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
      })
    ).id;
  }

  /** Festgeschriebene Rechnung über eine Position; `verkauf`: „Verkauf aus dem Anlagevermögen“ */
  async function rechnung(
    issueDate: string,
    net: number,
    verkauf: boolean,
    rate: 1900 | 700 | 0 = kleinunternehmer ? 0 : 1900,
    taxTreatment: TaxTreatment = kleinunternehmer ? "kleinunternehmer" : "regulaer",
    exemption: { number: string } | null = null,
  ) {
    const draft = await invoices.createDraft(actor, {
      contactId,
      issueDate,
      serviceFrom: null,
      serviceTo: null,
      paymentTermDays: 14,
      format: "zugferd",
      note: "",
      taxTreatment,
      taxDetails: { exemption, ancillary: null, foreignPlace: null, assetDisposal: verkauf },
      lines: [{ description: "Gebrauchte Kamera", quantity: 1000, unit: "Stk." as const, unitPrice: net, taxRate: rate }],
    });
    return invoices.finalizeInvoice(actor, draft.id, kleinunternehmerStand);
  }

  /** Eine Rechnung, wie Haben sie vor #2022 gebucht hat: Kennzeichen gesetzt, Erlös auf dem normalen Erlöskonto */
  async function alteRechnung(issueDate: string, net: number) {
    const invoice = await rechnung(issueDate, net, false);
    await sql.begin(async (tx) => {
      // Am Sperrtrigger vorbei, nur im Test: so stand die Rechnung vor #2022 in der Datenbank
      await tx`set local session_replication_role = replica`;
      await tx`update invoices set tax_details = ${JSON.stringify({ exemption: null, ancillary: null, foreignPlace: null, assetDisposal: true })}::jsonb
        where id = ${invoice.id}`;
    });
    return invoice;
  }

  /**
   * Entwurf einer Korrektur ueber eine Position. Fuer Faelle, die nicht den vollen Betrag aufheben sollen:
   * Eine Korrektur ueber den vollen Betrag einer unbezahlten Rechnung ist ein Storno und wird seit #2037 abgewiesen.
   */
  function teilkorrektur(net: number, issueDate: string) {
    return {
      contactId,
      issueDate,
      serviceFrom: null,
      serviceTo: null,
      paymentTermDays: 0,
      format: "zugferd" as const,
      note: "",
      taxTreatment: (kleinunternehmer ? "kleinunternehmer" : "regulaer") as TaxTreatment,
      taxDetails: { exemption: null, ancillary: null, foreignPlace: null, assetDisposal: true },
      lines: [
        {
          description: "Gebrauchte Kamera",
          quantity: 1000,
          unit: "Stk." as const,
          unitPrice: net,
          taxRate: (kleinunternehmer ? 0 : 1900) as 1900 | 700 | 0,
        },
      ],
    };
  }

  const bar = (invoiceId: string, date: string, amount: number) => cashInvoice.createCashInvoiceEntry(actor, { invoiceId, date, amount }, date);

  /** Haben-Saldo je Konto der Buchungen einer Rechnung, ohne Forderungen */
  async function konten(invoiceId: string, kontenrahmen: Kontenrahmen) {
    const rows = await sql<{ account: string; saldo: number }[]>`select l.account, sum(l.credit - l.debit)::int as saldo
      from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.source_type = 'invoice' and e.source_id = ${invoiceId} and l.account <> ${ACCOUNTS[kontenrahmen].forderungen}
      group by l.account order by l.account`;
    return Object.fromEntries(rows.map((r) => [r.account, r.saldo]));
  }

  async function euer(year: number) {
    const e = await reports.euerForYear(year);
    const zeile = (key: string) => [...e.einnahmen, ...e.ausgaben].find((l) => l.key === key)?.amount ?? 0;
    return {
      anlagenabgang: zeile("anlagenabgang"),
      steuerpflichtig: zeile("einnahmenSteuerpflichtig"),
      kleinunternehmer: zeile("einnahmenKleinunternehmer"),
      ust: zeile("vereinnahmteUst"),
      gewinn: e.gewinn,
      monate: e.monthly.einnahmen,
    };
  }

  const monate = (monat: number, betrag: number) => Array.from({ length: 12 }, (_, i) => (i === monat - 1 ? betrag : 0));

  for (const [kontenrahmen, versteuerung] of [
    ["SKR03", "ist"],
    ["SKR04", "soll"],
  ] as const) {
    it(`regelbesteuert: Erlös auf dem Verkaufskonto, Zeile 19 mit der Zahlung, ELSTER und Abgleich (${kontenrahmen}, ${versteuerung})`, async () => {
      await reset(versteuerung, kontenrahmen);
      const verkauf = await rechnung("2026-05-04", 40_000, true);
      const normal = await rechnung("2026-05-04", 10_000, false);
      expect(await konten(verkauf.id, kontenrahmen)).toEqual({
        [VERKAUF[kontenrahmen].ust19]: 40_000,
        [(versteuerung === "ist" ? ACCOUNTS[kontenrahmen].ustNichtFaellig : ACCOUNTS[kontenrahmen].ust)[1900]]: 7_600,
      });
      expect(Object.keys(await konten(normal.id, kontenrahmen))).toContain(ACCOUNTS[kontenrahmen].erloese[1900]);
      await bar(verkauf.id, "2026-05-10", 47_600);
      await bar(normal.id, "2026-06-10", 11_900);
      // Die Grafik zeigt den Verkaufserlös als Einnahme im Monat der Zahlung
      expect(await euer(2026)).toEqual({
        anlagenabgang: 40_000,
        steuerpflichtig: 10_000,
        kleinunternehmer: 0,
        ust: 9_500,
        gewinn: 59_500,
        monate: monate(5, 40_000).map((b, i) => (i === 5 ? 10_000 : b)),
      });
      const elster = await annual.euerYear(2026);
      expect(elster.figures.anlagenabgang).toBe(40_000);
      expect(elster.figures.steuerpflichtig).toBe(10_000);
      const pruefung = await abgleich.euerAbgleich(2026);
      expect(abgleich.abweichungen(pruefung.zeilen)).toEqual([]);
    }, 60_000);

    it(`Zahlung im Folgejahr: Zeile 19 erst im Jahr der Zahlung (${kontenrahmen}, ${versteuerung})`, async () => {
      await reset(versteuerung, kontenrahmen);
      const verkauf = await rechnung("2026-12-20", 40_000, true);
      await bar(verkauf.id, "2027-01-05", 47_600);
      expect((await euer(2026)).anlagenabgang).toBe(0);
      expect((await euer(2027)).anlagenabgang).toBe(40_000);
    }, 60_000);
  }

  for (const [kontenrahmen, versteuerung] of [
    ["SKR03", "soll"],
    ["SKR04", "ist"],
  ] as const) {
    it(`Kleinunternehmer: Zeile 19 statt 12 und 13, im Gesamtumsatz außer Ansatz (${kontenrahmen}, ${versteuerung})`, async () => {
      await reset(versteuerung, kontenrahmen, true);
      const verkauf = await rechnung("2026-05-04", 30_000, true);
      const normal = await rechnung("2026-05-04", 10_000, false);
      expect(await konten(verkauf.id, kontenrahmen)).toEqual({ [VERKAUF[kontenrahmen].ohneUst]: 30_000 });
      await bar(verkauf.id, "2026-05-10", 30_000);
      await bar(normal.id, "2026-05-11", 10_000);
      const e = await euer(2026);
      expect([e.anlagenabgang, e.kleinunternehmer, e.gewinn]).toEqual([30_000, 10_000, 40_000]);
      const elster = await annual.euerYear(2026);
      expect(elster.figures.anlagenabgang).toBe(30_000);
      expect(elster.figures.kleinunternehmer).toBe(10_000);
      expect(elster.figures.kleinunternehmerAbzuege ?? 0).toBe(0);
      const umsatz = await gesamtumsatz.gesamtumsatzForYear(2026);
      expect(umsatz.included).toBe(10_000);
      expect(umsatz.items.find((item) => item.net === 30_000)?.decision).toBe("excluded");
    }, 60_000);
  }

  for (const [kontenrahmen, versteuerung] of [
    ["SKR03", "ist"],
    ["SKR04", "soll"],
  ] as const) {
    it(`Rechnung von vor #2022 auf dem Erlöskonto: Zeile 19 nach dem Kennzeichen, Storno und Korrektur auf ihr Konto (${kontenrahmen}, ${versteuerung})`, async () => {
      await reset(versteuerung, kontenrahmen);
      const erloes = ACCOUNTS[kontenrahmen].erloese[1900];
      const bezahlt = await alteRechnung("2026-03-02", 40_000);
      await bar(bezahlt.id, "2026-03-09", 47_600);
      expect((await euer(2026)).anlagenabgang).toBe(40_000);
      expect((await euer(2026)).steuerpflichtig).toBe(0);

      const storniert = await alteRechnung("2026-03-02", 20_000);
      const storno = await invoices.cancelInvoice(actor, storniert.id, "2026-03-20");
      expect((await konten(storno.id, kontenrahmen))[erloes]).toBe(-20_000);
      expect((await konten(storno.id, kontenrahmen))[VERKAUF[kontenrahmen].ust19]).toBeUndefined();

      const korrigiert = await alteRechnung("2026-03-02", 30_000);
      const korrektur = await invoices.createCorrection(actor, korrigiert.id, "2026-03-25");
      // Teilkorrektur statt voller Aufhebung: Geprueft wird das Konto, auf das die Korrektur bucht. Die volle
      // Aufhebung einer unbezahlten Rechnung ist ein Storno und seit #2037 abgewiesen (siehe correction-checks.test.ts).
      await invoices.updateDraft(actor, korrektur.id, teilkorrektur(-10_000, "2026-03-25"));
      const fertig = await invoices.finalizeInvoice(actor, korrektur.id, kleinunternehmerStand);
      expect((await konten(fertig.id, kontenrahmen))[erloes]).toBe(-10_000);
      // Das Storno der Rechnung storniert auch die Korrektur, beides auf dem Erlöskonto
      await invoices.cancelInvoice(actor, korrigiert.id, "2026-03-26");
      const saldo = await sql<{ account: string; saldo: number }[]>`select account, sum(credit - debit)::int as saldo from journal_lines
        where account in (${erloes}, ${VERKAUF[kontenrahmen].ust19}) group by account`;
      expect(Object.fromEntries(saldo.map((r) => [r.account, r.saldo]))).toEqual({ [erloes]: 40_000 });
      expect((await euer(2026)).anlagenabgang).toBe(40_000);
    }, 60_000);

    it(`neue Rechnung: das Storno bucht auf das Verkaufskonto zurück (${kontenrahmen}, ${versteuerung})`, async () => {
      await reset(versteuerung, kontenrahmen);
      const verkauf = await rechnung("2026-03-02", 40_000, true);
      const storno = await invoices.cancelInvoice(actor, verkauf.id, "2026-03-20");
      expect((await konten(storno.id, kontenrahmen))[VERKAUF[kontenrahmen].ust19]).toBe(-40_000);
      expect((await konten(storno.id, kontenrahmen))[ACCOUNTS[kontenrahmen].erloese[1900]]).toBeUndefined();
    }, 60_000);
  }

  // Ohne Verkaufskonto bei DATEV (7 %, steuerfrei, § 13b, Drittland, nicht steuerbar) bleibt der Erlös auf dem Erlöskonto mit
  // Automatik; die EÜR nimmt ihn über das Kennzeichen der Rechnung trotzdem in Zeile 19, auch bei Teilzahlung und Storno
  for (const [kontenrahmen, versteuerung, rate, treatment, exemption, erloes] of [
    ["SKR03", "soll", 700, "regulaer", null, "8300"],
    ["SKR04", "ist", 0, "steuerfrei", { number: "28" }, "4100"],
  ] as const) {
    it(`${treatment} ${rate / 100} %: Erlöskonto wie bisher, Zeile 19 mit jeder Teilzahlung, Storno auf dasselbe Konto (${kontenrahmen}, ${versteuerung})`, async () => {
      await reset(versteuerung, kontenrahmen);
      const verkauf = await rechnung("2026-05-04", 40_000, true, rate, treatment, exemption);
      const brutto = rate === 700 ? 42_800 : 40_000;
      expect(Object.keys(await konten(verkauf.id, kontenrahmen))).toContain(erloes);
      expect(Object.keys(await konten(verkauf.id, kontenrahmen))).not.toContain(VERKAUF[kontenrahmen].ohneUst);
      await bar(verkauf.id, "2026-05-10", brutto / 2);
      expect((await euer(2026)).anlagenabgang).toBe(20_000);
      await bar(verkauf.id, "2026-06-10", brutto / 2);
      const e = await euer(2026);
      expect([e.anlagenabgang, e.steuerpflichtig, e.ust]).toEqual([40_000, 0, brutto - 40_000]);
      expect(e.monate).toEqual(monate(5, 20_000).map((b, i) => (i === 5 ? 20_000 : b)));

      const zweite = await rechnung("2026-07-01", 10_000, true, rate, treatment, exemption);
      const storno = await invoices.cancelInvoice(actor, zweite.id, "2026-07-02");
      expect((await konten(storno.id, kontenrahmen))[erloes]).toBe(-10_000);
      expect((await euer(2026)).anlagenabgang).toBe(40_000);
    }, 60_000);
  }

  it("noch nicht gebuchte Anlagen: Zeile 19 behält den Verkaufserlös neben der Entnahme aus dem Anlagenverzeichnis", async () => {
    await reset("soll", "SKR03");
    await assets.createAsset(actor, {
      name: "Laptop",
      kind: "edv",
      method: "linear",
      acquisitionDate: "2026-01-10",
      cost: 120_000,
      usefulLifeMonths: 36,
      openingDate: "2026-01-10",
      openingBookValue: 120_000,
      disposalDate: null,
      note: "",
    });
    await assets.createAsset(actor, {
      name: "Kamera",
      kind: "sonstiges",
      method: "linear",
      acquisitionDate: "2024-01-10",
      cost: 60_000,
      usefulLifeMonths: 60,
      openingDate: "2026-01-01",
      openingBookValue: 36_000,
      disposalDate: "2026-08-31",
      disposalWithdrawal: { value: 10_000, inputVat: false },
      note: "",
    });
    const verkauf = await rechnung("2026-05-04", 40_000, true);
    await bar(verkauf.id, "2026-05-10", 47_600);
    expect((await assets.listAssets(2026)).some((a) => a.pending)).toBe(true);
    const offen = await euer(2026);
    expect(offen.anlagenabgang).toBe(50_000);
    expect(offen.monate).toEqual(monate(5, 40_000));
    await buchhaltung.bookDepreciation(actor, 2026, "2026-12-31");
    expect((await assets.listAssets(2026)).some((a) => a.pending)).toBe(false);
    const gebucht = await euer(2026);
    expect(gebucht.anlagenabgang).toBe(50_000);
    expect(gebucht.monate).toEqual(monate(5, 40_000));
    expect(gebucht.gewinn).toBe(offen.gewinn);
  }, 60_000);
});
