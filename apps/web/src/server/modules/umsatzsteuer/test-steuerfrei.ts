import type postgres from "postgres";
import { afterAll, beforeAll, expect } from "vitest";
import { leeren, setupTestDb } from "../../test-db.ts";
import { kleinunternehmerStand } from "../auswertungen/test-umsatz-stand.ts";

/*
 * Testumgebung für Kz 43 und 48 im Zeitraum der Leistung (#1312): eine Firma, Rechnungen über § 4 und Ausfuhr, Zahlungen
 * über den Bankabgleich und die Kennzahl je Monat samt Gegenprobe mit den Quellen und dem Journal. Für
 * steuerfrei-ist.test.ts und steuerfrei-uebergang.test.ts.
 */

export type Behandlung = "steuerfrei" | "ausfuhr";
export const KZ = { steuerfrei: "kz48", ausfuhr: "kz43" } as const;
export type Zeitraum = { year: number; month: number };

function dkbCsv(rows: string[][]) {
  const header = `"Girokonto";"DE12 1203 0000 1234 5678 90"\n""\n`;
  const columns = `"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"\n`;
  return new TextEncoder().encode(`${header + columns + rows.map((r) => r.map((c) => `"${c}"`).join(";")).join("\n")}\n`);
}

/** Registriert beforeAll/afterAll; die Module stehen erst in den Tests bereit */
export function steuerfreiTestumgebung(actor: string) {
  const m = {} as {
    sql: postgres.Sql;
    vat: typeof import("./index.ts");
    bank: typeof import("../bank/index.ts");
    invoices: typeof import("../rechnungen/index.ts");
    contacts: typeof import("../stammdaten/contacts.ts");
    abgleich: typeof import("../auswertungen/abgleich.ts");
  };
  beforeAll(async () => {
    m.sql = await setupTestDb();
    m.vat = await import("./index.ts");
    m.bank = await import("../bank/index.ts");
    m.invoices = await import("../rechnungen/index.ts");
    m.contacts = await import("../stammdaten/contacts.ts");
    m.abgleich = await import("../auswertungen/abgleich.ts");
  }, 30_000);
  afterAll(async () => {
    await m.sql?.end();
  });

  async function firma(kontenrahmen: "SKR03" | "SKR04", versteuerung: "ist" | "soll") {
    await leeren(m.sql)`truncate vat_return_submissions, vat_returns, write_offs, allocations, bank_transactions, bank_imports,
      bank_accounts, cash_entries, journal_lines, journal_entries, invoice_lines, invoice_taxes, invoices, invoice_number_counters,
      contact_versions, contacts, company cascade`;
    await m.sql`insert into company (id, name, strasse, plz, ort, email, telefon, steuernummer, ust_id, bundesland, iban, versteuerung, kontenrahmen)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '+49 941 1', '198/113/10010',
              'DE123456789', 'BY', 'DE89370400440532013000', ${versteuerung}, ${kontenrahmen})`;
  }

  async function kunde(behandlung: Behandlung) {
    return (
      await m.contacts.createContact(actor, {
        kundennummer: "",
        name: `Kunde ${behandlung}`,
        strasse: "Ring 1",
        plz: behandlung === "ausfuhr" ? "8001" : "20457",
        ort: behandlung === "ausfuhr" ? "Zürich" : "Hamburg",
        land: behandlung === "ausfuhr" ? "CH" : "DE",
        email: "a@b.example",
        ustId: "",
        iban: "",
        leitwegId: "",
        defaultFormat: null,
      })
    ).id;
  }

  async function rechnung(behandlung: Behandlung, net: number, felder: Record<string, unknown>) {
    const draft = await m.invoices.createDraft(actor, {
      contactId: await kunde(behandlung),
      paymentTermDays: 14,
      format: "zugferd",
      note: "",
      taxTreatment: behandlung,
      exemptionReason: behandlung === "steuerfrei" ? "Steuerfrei nach § 4 Nr. 14 UStG" : "Steuerfreie Ausfuhrlieferung nach § 4 Nr. 1 Buchst. a UStG",
      lines: [{ description: "Leistung", quantity: 1000, unit: "Psch." as const, unitPrice: net, taxRate: 0 }],
      serviceTo: null,
      ...felder,
    } as never);
    return m.invoices.finalizeInvoice(actor, draft.id, kleinunternehmerStand);
  }

  async function zahlung(invoiceId: string, date: string, amount: string) {
    const purpose = crypto.randomUUID();
    const row = [date, date, "Gebucht", "Kunde", "Testfirma", purpose, "Eingang", "DE02100100100006820101", amount, "", "", ""];
    await m.bank.importStatement(actor, { bytes: dkbCsv([row]), filename: `${purpose}.csv` }, null);
    const [tx] = await m.sql`select id, amount from bank_transactions where purpose = ${purpose}`;
    await m.bank.allocate(actor, { kind: "invoice", transactionId: tx!.id, invoiceId, amount: Number(tx!.amount) });
  }

  /** Kz 43 bzw. 48 je Monat; die Quellen unter der Kennzahl ergeben denselben Betrag */
  async function kennzahl(behandlung: Behandlung, period: Zeitraum) {
    const f = await m.vat.computeVatFigures(period);
    const ausQuellen = f.revenue.filter((r) => r.treatment === behandlung).reduce((s, r) => s + r.base, 0);
    expect(ausQuellen, `Quellen ${behandlung} ${period.month}/${period.year}`).toBe(f[KZ[behandlung]]);
    return f[KZ[behandlung]];
  }

  async function kennzahlen(behandlung: Behandlung, periods: Zeitraum[]) {
    const result: number[] = [];
    for (const p of periods) result.push(await kennzahl(behandlung, p));
    return result;
  }

  async function journalSauber(periods: Zeitraum[]) {
    for (const p of periods) expect(m.abgleich.abweichungen((await m.abgleich.vatAbgleich(p)).zeilen), JSON.stringify(p)).toEqual([]);
  }

  return { m, firma, kunde, rechnung, zahlung, kennzahl, kennzahlen, journalSauber };
}
