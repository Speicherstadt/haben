import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { kleinunternehmerStand } from "../auswertungen/test-umsatz-stand.ts";

/*
 * Übergang zu Kz 43 und 48 im Zeitraum der Leistung (#1312), wie bei der Rückgewähr (#1228): Die neue Regel gilt nur für
 * Rechnungen über § 4 und Ausfuhr, die nach dem Update festgeschrieben werden (Kennzeichen exempt_rule, gesetzt beim
 * Festschreiben). Vorher festgeschriebene zählen samt Storno, Korrektur und Zahlungen weiter wie bisher (Ist: mit der
 * Zahlung, Anzahlungen mit ihrer Zahlung), so ändert sich keine gesendete Voranmeldung und kein Umsatz fehlt in allen.
 * Entscheidung des Maintainers: https://github.com/Speicherstadt/haben/pull/1771 (Antworten auf die offenen Fragen 1 bis 5).
 * Storno einer Schlussrechnung nach Zahlung: eine Regel für Kz 43 und 48 wie als Kleinunternehmer (#1745), die bezahlte
 * Anzahlung zählt zum schon bezahlten Entgelt (UStAE 17.1 Abs. 2 Satz 3).
 */

type Behandlung = "steuerfrei" | "ausfuhr";
const KZ = { steuerfrei: "kz48", ausfuhr: "kz43" } as const;
type Zeitraum = { year: number; month: number };

function dkbCsv(rows: string[][]) {
  const header = `"Girokonto";"DE12 1203 0000 1234 5678 90"\n""\n`;
  const columns = `"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"\n`;
  return new TextEncoder().encode(`${header + columns + rows.map((r) => r.map((c) => `"${c}"`).join(";")).join("\n")}\n`);
}

const SEP = { year: 2026, month: 9 };
const OKT = { year: 2026, month: 10 };
const NOV = { year: 2026, month: 11 };
const DEZ = { year: 2026, month: 12 };
const JAN27 = { year: 2027, month: 1 };

describe.skipIf(!testDatabaseUrl)("Kz 43 und 48: Übergang und Storno nach Zahlung (Postgres)", () => {
  const actor = "kz48-uebergang-test";
  let vat: typeof import("./index.ts");
  let bank: typeof import("../bank/index.ts");
  let invoices: typeof import("../rechnungen/index.ts");
  let contacts: typeof import("../stammdaten/contacts.ts");
  let abgleich: typeof import("../auswertungen/abgleich.ts");
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = await setupTestDb();
    vat = await import("./index.ts");
    bank = await import("../bank/index.ts");
    invoices = await import("../rechnungen/index.ts");
    contacts = await import("../stammdaten/contacts.ts");
    abgleich = await import("../auswertungen/abgleich.ts");
  }, 30_000);
  afterAll(async () => {
    await sql?.end();
  });

  async function firma(kontenrahmen: "SKR03" | "SKR04", versteuerung: "ist" | "soll") {
    await leeren(sql)`truncate vat_return_submissions, vat_returns, write_offs, allocations, bank_transactions, bank_imports,
      bank_accounts, cash_entries, journal_lines, journal_entries, invoice_lines, invoice_taxes, invoices, invoice_number_counters,
      contact_versions, contacts, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, telefon, steuernummer, ust_id, bundesland, iban, versteuerung, kontenrahmen)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '+49 941 1', '198/113/10010',
              'DE123456789', 'BY', 'DE89370400440532013000', ${versteuerung}, ${kontenrahmen})`;
  }

  async function kunde(behandlung: Behandlung) {
    return (
      await contacts.createContact(actor, {
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
    const draft = await invoices.createDraft(actor, {
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
    return invoices.finalizeInvoice(actor, draft.id, kleinunternehmerStand);
  }

  async function zahlung(invoiceId: string, date: string, amount: string) {
    const purpose = crypto.randomUUID();
    const row = [date, date, "Gebucht", "Kunde", "Testfirma", purpose, "Eingang", "DE02100100100006820101", amount, "", "", ""];
    await bank.importStatement(actor, { bytes: dkbCsv([row]), filename: `${purpose}.csv` }, null);
    const [tx] = await sql`select id, amount from bank_transactions where purpose = ${purpose}`;
    await bank.allocate(actor, { kind: "invoice", transactionId: tx!.id, invoiceId, amount: Number(tx!.amount) });
  }

  /** Kz 43 bzw. 48 je Monat; die Quellen unter der Kennzahl ergeben denselben Betrag */
  async function kennzahl(behandlung: Behandlung, period: Zeitraum) {
    const f = await vat.computeVatFigures(period);
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
    for (const p of periods) expect(abgleich.abweichungen((await abgleich.vatAbgleich(p)).zeilen), JSON.stringify(p)).toEqual([]);
  }

  /**
   * Wie vor dem Update festgeschrieben: ohne Kennzeichen. Der Sperrtrigger lässt das an einer festgeschriebenen Rechnung
   * nicht zu, deshalb ohne Trigger in dieser Sitzung; das Siegel prüft dieser Test nicht.
   */
  async function wieVorDemUpdate(id: string) {
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update invoices set exempt_rule = null where id = ${id}`;
    });
  }

  for (const [kontenrahmen, behandlung] of [
    ["SKR03", "steuerfrei"],
    ["SKR04", "ausfuhr"],
  ] as const)
    it(`${kontenrahmen}/ist: vor dem Update festgeschriebene Rechnung zählt ${KZ[behandlung]} weiter mit der Zahlung, eine neue im Monat der Leistung`, async () => {
      await firma(kontenrahmen, "ist");
      const alt = await rechnung(behandlung, 50_000, { issueDate: "2026-10-03", serviceFrom: "2026-09-01", serviceTo: "2026-09-30" });
      await wieVorDemUpdate(alt.id);
      const neu = await rechnung(behandlung, 30_000, { issueDate: "2026-10-04", serviceFrom: "2026-09-01", serviceTo: "2026-09-30" });
      await zahlung(alt.id, "05.11.26", "500,00");
      await zahlung(neu.id, "05.11.26", "300,00");
      expect(await kennzahlen(behandlung, [SEP, OKT, NOV])).toEqual([30_000, 0, 50_000]);
      await journalSauber([SEP, OKT, NOV]);
    }, 60_000);

  for (const [kontenrahmen, versteuerung, behandlung] of [
    ["SKR04", "ist", "steuerfrei"],
    ["SKR03", "soll", "ausfuhr"],
  ] as const)
    it(`${kontenrahmen}/${versteuerung}: Anzahlung von vor dem Update zählt ${KZ[behandlung]} weiter mit ihrer Zahlung, die neue Schlussrechnung nur mit dem Rest`, async () => {
      await firma(kontenrahmen, versteuerung);
      const anzahlung = await rechnung(behandlung, 20_000, { issueDate: "2026-09-05", serviceFrom: null, variant: "abschlag", advanceType: "anzahlung" });
      await wieVorDemUpdate(anzahlung.id);
      await zahlung(anzahlung.id, "10.09.26", "200,00");
      const schluss = await rechnung(behandlung, 100_000, {
        issueDate: "2026-11-02",
        serviceFrom: "2026-10-01",
        serviceTo: "2026-10-31",
        variant: "schluss",
        deducts: [anzahlung.id],
        contactId: anzahlung.contactId,
      });
      await zahlung(schluss.id, "16.11.26", "800,00");
      // Sonst stünde die Anzahlung zweimal in der Kennzahl: im September und in der Leistung im Oktober
      expect(await kennzahlen(behandlung, [SEP, OKT, NOV])).toEqual([20_000, 80_000, 0]);
      await journalSauber([SEP, OKT, NOV]);
    }, 60_000);

  for (const [kontenrahmen, versteuerung, behandlung] of [
    ["SKR03", "ist", "steuerfrei"],
    ["SKR04", "soll", "ausfuhr"],
  ] as const)
    it(`${kontenrahmen}/${versteuerung}: Storno einer bezahlten Schlussrechnung hält auch die bezahlte Anzahlung in ${KZ[behandlung]} bis zur Rückzahlung`, async () => {
      await firma(kontenrahmen, versteuerung);
      const anzahlung = await rechnung(behandlung, 20_000, { issueDate: "2026-09-05", serviceFrom: null, variant: "abschlag", advanceType: "anzahlung" });
      await zahlung(anzahlung.id, "10.09.26", "200,00");
      const schluss = await rechnung(behandlung, 100_000, {
        issueDate: "2026-11-02",
        serviceFrom: "2026-10-01",
        serviceTo: "2026-10-31",
        variant: "schluss",
        deducts: [anzahlung.id],
        contactId: anzahlung.contactId,
      });
      await zahlung(schluss.id, "16.11.26", "800,00");
      const storno = await invoices.cancelInvoice(actor, schluss.id, "2026-11-20");
      // 1.000 € bezahlt (200 € Anzahlung, 800 € Rest), im November nichts zurückgezahlt
      const anzahlungStorno = await invoices.cancelInvoice(actor, anzahlung.id, "2026-12-02");
      await zahlung(anzahlungStorno.id, "03.12.26", "-200,00");
      await zahlung(storno.id, "12.01.27", "-800,00");
      expect(await kennzahlen(behandlung, [SEP, OKT, NOV, DEZ, JAN27])).toEqual([0, 100_000, 0, -20_000, -80_000]);
      await journalSauber([SEP, OKT, NOV, DEZ, JAN27]);
    }, 60_000);

  it("setzt das Kennzeichen beim Festschreiben von Rechnungen über § 4 und Ausfuhr, nicht bei anderen und nicht beim Storno", async () => {
    await firma("SKR03", "ist");
    const steuerfrei = await rechnung("steuerfrei", 10_000, { issueDate: "2026-10-01", serviceFrom: "2026-10-01" });
    const anzahlung = await rechnung("ausfuhr", 10_000, { issueDate: "2026-10-01", serviceFrom: null, variant: "abschlag", advanceType: "anzahlung" });
    const storno = await invoices.cancelInvoice(actor, steuerfrei.id, "2026-10-05");
    const draft = await invoices.createDraft(actor, {
      contactId: steuerfrei.contactId!,
      issueDate: "2026-10-01",
      serviceFrom: null,
      serviceTo: null,
      paymentTermDays: 14,
      format: "zugferd",
      note: "",
      lines: [{ description: "Beratung", quantity: 1000, unit: "Psch." as const, unitPrice: 10_000, taxRate: 1900 }],
    } as never);
    const regulaer = await invoices.finalizeInvoice(actor, draft.id, kleinunternehmerStand);
    const rows = await sql`select id, exempt_rule from invoices`;
    const regel = new Map(rows.map((r) => [r.id, r.exempt_rule]));
    expect([regel.get(steuerfrei.id), regel.get(anzahlung.id), regel.get(storno.id), regel.get(regulaer.id)]).toEqual(["leistung", "leistung", null, null]);
  }, 60_000);

  it("lehnt eine ohne Kennzeichen festgeschriebene steuerfreie Rechnung in der Datenbank ab", async () => {
    await firma("SKR04", "soll");
    const inv = await rechnung("steuerfrei", 10_000, { issueDate: "2026-10-01", serviceFrom: "2026-10-01" });
    await expect(
      sql`insert into invoices (kind, contact_id, issue_date, due_date, payment_term_days, tax_treatment, status, number, locked_at)
        values ('rechnung', ${inv.contactId}, '2026-10-01', '2026-10-01', 0, 'steuerfrei', 'final', 'X-1', now())`.then((r) => r),
    ).rejects.toThrow(/Kennzeichen/);
    const [draft] = await sql`insert into invoices (kind, contact_id, issue_date, due_date, payment_term_days, tax_treatment)
      values ('rechnung', ${inv.contactId}, '2026-10-01', '2026-10-01', 0, 'ausfuhr') returning id`;
    await expect(sql`update invoices set status = 'final', number = 'X-2', locked_at = now() where id = ${draft!.id}`.then((r) => r)).rejects.toThrow(
      /Kennzeichen/,
    );
    await expect(sql`update invoices set exempt_rule = 'leistung', tax_treatment = 'regulaer' where id = ${draft!.id}`.then((r) => r)).rejects.toThrow(
      /invoices_exempt_rule/,
    );
  }, 60_000);

  it("SKR03/ist: gesendete Voranmeldung mit einer Rechnung von vor dem Update meldet keine Abweichung", async () => {
    await firma("SKR03", "ist");
    const alt = await rechnung("steuerfrei", 50_000, { issueDate: "2026-10-03", serviceFrom: "2026-09-01", serviceTo: "2026-09-30" });
    await wieVorDemUpdate(alt.id);
    await zahlung(alt.id, "05.11.26", "500,00");
    const entwurf = await vat.saveDraft(actor, NOV, { mode: "berechnet" });
    expect(entwurf.kz48).toBe(50_000);
    await sql`update vat_returns set status = 'sent', sent_at = now() where id = ${entwurf.id}`;
    expect(await vat.gesendeteAbweichungen([2026])).toEqual([]);
  }, 60_000);

  it("SKR04/ist: nach dem Update festgeschriebene Rechnung mit Leistung in einem gesendeten Monat fällt im Abgleich auf", async () => {
    // Offene Frage 1 im PR: Mit dem Übergang ist die Zuordnung von vor dem Update keine Ausrede mehr für eine Abweichung
    await firma("SKR04", "ist");
    const entwurf = await vat.saveDraft(actor, SEP, { mode: "berechnet" });
    await sql`update vat_returns set status = 'sent', sent_at = now() - interval '1 day' where id = ${entwurf.id}`;
    const inv = await rechnung("ausfuhr", 30_000, { issueDate: "2026-10-04", serviceFrom: "2026-09-01", serviceTo: "2026-09-30" });
    await zahlung(inv.id, "05.10.26", "300,00");
    expect(await vat.gesendeteAbweichungen([2026])).toEqual([{ period: SEP, feld: "Kz 43", gesendet: 0, journal: 30_000 }]);
  }, 60_000);
});
