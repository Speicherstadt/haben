import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kennzahlenAusJournal } from "@haben/core";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Privatentnahme als Zeile einer Aufteilung (#1975), Telefon-Beispiel aus dem Issue: 50,14 € brutto, 42,13 € netto,
 * 8,01 € Vorsteuer. Internet 33,60 € netto zu 25 % privat, Telefon 8,53 € netto zu 40 % privat. Gebucht: 30,32 €
 * Aufwand, 5,76 € Vorsteuer, 14,06 € Entnahme (11,81 € netto, 2,25 € Steuer). Geprüft wird das Journal, Kz 66 aus
 * Journal und Nebenbuch und die EÜR, in SKR03 und SKR04, Ist und Soll.
 */

const KONTEN = {
  SKR03: { internet: "4925", telefon: "4920", entnahme: "1800", vorsteuer: "1576", verbindlichkeiten: "1600" },
  SKR04: { internet: "6810", telefon: "6805", entnahme: "2100", vorsteuer: "1406", verbindlichkeiten: "3300" },
} as const;

const SPLITS = [
  { category: "internet" as const, taxRate: 1900 as const, net: 2_520 },
  { category: "privatentnahme" as const, taxRate: 1900 as const, net: 840 },
  { category: "telefon" as const, taxRate: 1900 as const, net: 512 },
  { category: "privatentnahme" as const, taxRate: 1900 as const, net: 341 },
];

function dkbCsv(rows: string[][]) {
  const header = `"Girokonto";"DE12 1203 0000 1234 5678 90"\n""\n`;
  const columns = `"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"\n`;
  return new TextEncoder().encode(`${header + columns + rows.map((r) => r.map((c) => `"${c}"`).join(";")).join("\n")}\n`);
}

describe.skipIf(!testDatabaseUrl)("Privatentnahme in einer Aufteilung (Postgres)", () => {
  let documents: typeof import("./documents.ts");
  let vat: typeof import("../umsatzsteuer/vat-figures.ts");
  let reports: typeof import("../auswertungen/reports.ts");
  let abgleich: typeof import("../auswertungen/abgleich.ts");
  let bank: typeof import("../bank/index.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  let fileSeq = 0;

  beforeAll(async () => {
    sql = await setupTestDb();
    documents = await import("./documents.ts");
    vat = await import("../umsatzsteuer/vat-figures.ts");
    reports = await import("../auswertungen/reports.ts");
    abgleich = await import("../auswertungen/abgleich.ts");
    bank = await import("../bank/index.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function reset(kontenrahmen: "SKR03" | "SKR04", versteuerung: "ist" | "soll", rechtsform = "einzelunternehmen") {
    await leeren(sql)`truncate document_cancellations, vat_returns, write_offs, allocations, bank_transactions, bank_imports, bank_accounts, cash_entries,
      asset_depreciations, assets, journal_lines, journal_entries, document_splits, document_amounts, documents, year_closings, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, versteuerung, kontenrahmen, kleinunternehmer, rechtsform)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'BY', ${versteuerung}, ${kontenrahmen}, false, ${rechtsform})`;
  }

  async function draft() {
    fileSeq++;
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, fileSeq % 256, Math.floor(fileSeq / 256), 71]);
    const { id } = await documents.uploadDocument(actor, { bytes, filename: `privat-${fileSeq}.jpg` });
    await documents.updateDocument(actor, id, {
      supplierName: "Telekom Deutschland GmbH",
      supplierUstId: "",
      invoiceNumber: `TK-${fileSeq}`,
      documentDate: "2026-09-15",
      dueDate: null,
      category: "sonstiges",
      payment: "bank",
      note: "",
      privateShare: 0,
      reverseCharge: null,
      currency: "EUR",
      exchangeRate: null,
      amounts: [{ taxRate: 1900, net: 4_213, tax: 801 }],
      splits: SPLITS,
    });
    return id;
  }

  /** Die Zahlung des Belegs über die Bank, damit die EÜR sie mit dem Zahlbetrag sieht */
  async function pay(documentId: string) {
    await bank.importStatement(
      actor,
      {
        bytes: dkbCsv([["20.09.26", "20.09.26", "Gebucht", "Testfirma", "Telekom", "TK", "Ausgang", "DE02100100100006820101", "-50,14", "", "", ""]]),
        filename: `konto-${fileSeq}.csv`,
      },
      null,
    );
    const [transaction] = await sql`select id, amount from bank_transactions order by booking_date`;
    await bank.allocate(actor, { kind: "document", transactionId: transaction!.id as string, documentId, amount: transaction!.amount as number });
  }

  async function entryLines(documentId: string) {
    return sql`select l.account, l.debit, l.credit, l.tax_code from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.source_type = 'document' and e.source_id = ${documentId} and e.reverses_id is null order by l.account`;
  }

  const byAccount = <T extends { account: string }>(lines: T[]) => [...lines].sort((a, b) => a.account.localeCompare(b.account));
  const sum = (values: number[]) => values.reduce((s, v) => s + v, 0);
  const ausgabe = (euer: Awaited<ReturnType<typeof reports.euerForYear>>, key: string) => euer.ausgaben.find((l) => l.key === key)?.amount ?? 0;

  for (const kontenrahmen of ["SKR03", "SKR04"] as const) {
    for (const versteuerung of ["ist", "soll"] as const) {
      const k = KONTEN[kontenrahmen];

      it(`${kontenrahmen}, ${versteuerung}: Entnahme brutto, Vorsteuer nur betrieblich, Kz 66 und EÜR stimmen`, async () => {
        await reset(kontenrahmen, versteuerung);
        const id = await draft();
        const saved = (await documents.getDocument(id))!;
        expect(saved.document.category).toBeNull();
        expect(saved.splits.map(({ category, taxRate, net, tax }) => ({ category, taxRate, net, tax }))).toEqual([
          { category: "internet", taxRate: 1900, net: 2_520, tax: 479 },
          { category: "privatentnahme", taxRate: 1900, net: 840, tax: 160 },
          { category: "telefon", taxRate: 1900, net: 512, tax: 97 },
          { category: "privatentnahme", taxRate: 1900, net: 341, tax: 65 },
        ]);
        expect(documents.bookingIssues(saved.document, saved.amounts, "2026-09-20", saved.splits)).toEqual([]);
        await documents.bookDocument(actor, id);

        const lines = await entryLines(id);
        expect(lines).toEqual(
          byAccount([
            { account: k.internet, debit: 2_520, credit: 0, tax_code: "VSt19" },
            { account: k.telefon, debit: 512, credit: 0, tax_code: "VSt19" },
            { account: k.entnahme, debit: 1_406, credit: 0, tax_code: "keineVSt" },
            { account: k.vorsteuer, debit: 576, credit: 0, tax_code: "VSt19" },
            { account: k.verbindlichkeiten, debit: 0, credit: 5_014, tax_code: null },
          ]),
        );
        expect(sum(lines.map((l) => l.debit as number))).toBe(sum(lines.map((l) => l.credit as number)));

        // Kz 66 aus dem Journal, direkt aus Konto und Steuerschlüssel
        const journal = await sql`select l.account, l.debit, l.credit, l.tax_code from journal_lines l join journal_entries e on e.id = l.entry_id
          where e.source_type = 'document' and e.source_id = ${id} and e.reverses_id is null order by l.account`;
        const kennzahlen = kennzahlenAusJournal(kontenrahmen, versteuerung, [
          journal.map((l) => ({ account: l.account as string, debit: l.debit as number, credit: l.credit as number, taxCode: l.tax_code as string | null })),
        ]);
        expect(kennzahlen.kz66).toBe(576);

        // Kz 66 aus dem Nebenbuch (Belege): dieselbe Zahl, die der Entnahmeanteil mindert
        const september = await vat.computeVatFigures({ year: 2026, month: 9 });
        expect(september.kz66).toBe(576);
        expect(september.inputTax).toEqual([expect.objectContaining({ documentId: id, base: 3_032, tax: 576 })]);
        expect((await abgleich.vatAbgleich({ year: 2026, month: 9 })).zeilen.filter((z) => z.journal !== z.quelle)).toEqual([]);

        // EÜR: nur der betriebliche Teil ist Aufwand, die Entnahme erscheint nicht
        await pay(id);
        const euer = await reports.euerForYear(2026);
        expect(ausgabe(euer, "ausgabe:internet")).toBe(2_520);
        expect(ausgabe(euer, "ausgabe:telefon")).toBe(512);
        expect(ausgabe(euer, "ausgabe:privatentnahme")).toBe(0);
        expect(ausgabe(euer, "vorsteuer")).toBe(576);
        expect(euer.totalAusgaben).toBe(3_032 + 576);
      });
    }
  }

  it("weist die Entnahme in einer GmbH ab (#1975)", async () => {
    await reset("SKR03", "ist", "gmbh");
    const id = await draft();
    const saved = (await documents.getDocument(id))!;
    expect(documents.bookingIssues(saved.document, saved.amounts, "2026-09-20", saved.splits, "gmbh")).toContain(
      "Einen Privatanteil gibt es nur im Einzelunternehmen",
    );
    await expect(documents.bookDocument(actor, id)).rejects.toThrow(/nur im Einzelunternehmen/);
  });

  it("weist Skonto auf einem Beleg mit Entnahmezeile ab (#1975)", async () => {
    await reset("SKR03", "soll");
    const id = await draft();
    await documents.bookDocument(actor, id);
    await expect(bank.writeOff(actor, { kind: "skontoErhalten", documentId: id, date: "2026-10-01" })).rejects.toThrow(
      "Skonto auf Belege mit Privatanteil wird nicht unterstützt.",
    );
  });

  it("nimmt privatentnahme nicht als Kategorie des Belegs an (#1975)", async () => {
    await reset("SKR03", "ist");
    const { id } = await documents.uploadDocument(actor, { bytes: new Uint8Array([0xff, 0xd8, 0xff, 71]), filename: `kategorie-${fileSeq++}.jpg` });
    await expect(
      documents.updateDocument(actor, id, {
        supplierName: "Telekom",
        supplierUstId: "",
        invoiceNumber: "TK-K",
        documentDate: "2026-09-15",
        dueDate: null,
        category: "privatentnahme" as never,
        payment: "bank",
        note: "",
        privateShare: 0,
        reverseCharge: null,
        currency: "EUR",
        exchangeRate: null,
        amounts: [{ taxRate: 1900, net: 100, tax: 19 }],
        splits: [],
      }),
    ).rejects.toThrow();
  });
});
