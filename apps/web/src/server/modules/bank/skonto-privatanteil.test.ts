import { readFileSync } from "node:fs";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Erhaltenes Skonto auf einem aufgeteilten Beleg (#1914): Trägt eine Zeile einen Privatanteil, ist documents.private_share
 * 0. Die Sperre am Beleg allein greift dort nicht, und das Skonto mindert die volle Vorsteuer, obwohl nur der betriebliche
 * Teil gebucht ist. Gesperrt ist deshalb jeder Beleg, dessen Zeilen einen Anteil tragen; ohne Anteil bleibt Skonto möglich.
 */
describe.skipIf(!testDatabaseUrl)("Skonto und Privatanteil je Zeile", () => {
  let documents: typeof import("../belege/documents.ts");
  let bank: typeof import("./index.ts");
  let sql: postgres.Sql;
  const actor = "skonto-privatanteil";
  let lauf = 0;
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 94]);
  /** E-Rechnung (CII) mit Skonto nach XRechnung BR-DE-18: 2 % in 7 Tagen */
  const einvoice = () =>
    new TextEncoder().encode(
      readFileSync(new URL("../../../../../../packages/einvoice/test-fixtures/incoming/cii-prefixes.xml", import.meta.url), "utf8").replace(
        "<a:SpecifiedTradePaymentTerms>",
        "<a:SpecifiedTradePaymentTerms><a:Description>#SKONTO#TAGE=7#PROZENT=2.00#\n</a:Description></a:SpecifiedTradePaymentTerms><a:SpecifiedTradePaymentTerms>",
      ),
    );

  beforeAll(async () => {
    sql = await setupTestDb();
    documents = await import("../belege/documents.ts");
    bank = await import("./index.ts");
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    await leeren(sql)`truncate document_cancellations, document_settlements, vat_returns, write_offs, allocations, cash_entries,
      bank_transactions, bank_imports, bank_accounts, journal_lines, journal_entries, document_amounts, document_splits,
      documents, year_closings, contact_versions, contacts, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, telefon, steuernummer, ust_id, bundesland, iban, versteuerung,
        kontenrahmen, rechtsform, kleinunternehmer, payment_term_days)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '+49 941 1', '198/113/10010',
              'DE123456789', 'BY', 'DE89370400440532013000', 'ist', 'SKR03', 'einzelunternehmen', false, 14)`;
  });

  /** Gebuchter Beleg über Internet und Telefon, je 12.000 Cent netto zu 19 %; nur die Internet-Zeile trägt einen Anteil */
  async function beleg(zeilenAnteil: number, datei?: { bytes: Uint8Array; endung: string }) {
    lauf++;
    const bytes = datei?.bytes ?? new Uint8Array([...JPEG, lauf % 251]);
    const { id } = await documents.uploadDocument(actor, { bytes, filename: `skonto-${lauf}.${datei?.endung ?? "jpg"}` });
    await documents.updateDocument(actor, id, {
      supplierName: "Stadtwerke Beispiel GmbH",
      supplierUstId: "",
      invoiceNumber: `S-${lauf}`,
      documentDate: "2026-11-02",
      dueDate: null,
      category: "sonstiges",
      payment: "bank",
      note: "",
      privateShare: 0,
      amounts: [{ taxRate: 1900, net: 24_000, tax: 4_560 }],
      splits: [
        { category: "internet", taxRate: 1900, net: 12_000, privateShare: zeilenAnteil },
        { category: "telefon", taxRate: 1900, net: 12_000, privateShare: 0 },
      ],
    });
    await documents.bookDocument(actor, id);
    return id;
  }

  it("lehnt Skonto ab, sobald eine Zeile einen Privatanteil trägt", async () => {
    const id = await beleg(25);

    await expect(bank.writeOff(actor, { kind: "skontoErhalten", documentId: id, date: "2026-11-30" })).rejects.toThrow(
      "Skonto auf Belege mit Privatanteil wird nicht unterstützt.",
    );
    const [offen] = await sql`select count(*)::int as anzahl from write_offs`;
    expect(offen!.anzahl).toBe(0);
  });

  it("bucht Skonto auf einen aufgeteilten Beleg ohne Anteil weiterhin", async () => {
    const id = await beleg(0);

    await bank.writeOff(actor, { kind: "skontoErhalten", documentId: id, date: "2026-11-30" });

    const [gebucht] = await sql`select count(*)::int as anzahl from write_offs where document_id = ${id}`;
    expect(gebucht!.anzahl).toBe(1);
  });

  it("bietet in der Überweisungsliste kein Skonto an, sobald eine Zeile einen Privatanteil trägt", async () => {
    const id = await beleg(25, { bytes: einvoice(), endung: "xml" });

    const kandidat = (await bank.transferCandidates()).find((c) => c.documentId === id);
    expect(kandidat?.skontoTerms).toEqual([]);
  });
});
