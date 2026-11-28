import { readFileSync } from "node:fs";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Skonto und eine Entnahmezeile in der Aufteilung (#1975): Die Überweisungsliste bietet sonst ein Skonto an, das
 * `skontoErhalten` danach ablehnt — der Beleg wäre gekürzt überwiesen und bliebe teilweise offen. Beide Stellen fragen
 * deshalb dieselbe Funktion (`skontoMoeglich`), hier gegen Postgres geprüft.
 */

const ACCOUNT_IBAN = "DE89370400440532013000";
const SUPPLIER_IBAN = "DE02120300000000202051";

/** E-Rechnung (CII) mit Skonto nach XRechnung BR-DE-18: 2 % in 7 Tagen, 1 % in 14 Tagen */
const einvoice = () =>
  new TextEncoder().encode(
    readFileSync(new URL("../../../../../../packages/einvoice/test-fixtures/incoming/cii-prefixes.xml", import.meta.url), "utf8").replace(
      "<a:SpecifiedTradePaymentTerms>",
      "<a:SpecifiedTradePaymentTerms><a:Description>#SKONTO#TAGE=7#PROZENT=2.00#\n#SKONTO#TAGE=14#PROZENT=1.00#\n</a:Description></a:SpecifiedTradePaymentTerms><a:SpecifiedTradePaymentTerms>",
    ),
  );

describe.skipIf(!testDatabaseUrl)("Skonto und Privatentnahme (Postgres)", () => {
  let bank: typeof import("./index.ts");
  let documents: typeof import("../belege/documents.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  const now = new Date("2026-09-16T08:00:00Z");
  let counter = 0;

  beforeAll(async () => {
    sql = await setupTestDb();
    bank = await import("./index.ts");
    documents = await import("../belege/documents.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    await leeren(sql)`truncate document_iban_decisions, sepa_transfer_items, sepa_transfers, write_offs, allocations, bank_transactions,
      bank_imports, bank_accounts, journal_lines, journal_entries, document_amounts, document_splits, documents, contacts, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, iban, bic, versteuerung, kontenrahmen, rechtsform)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'BY',
              ${ACCOUNT_IBAN}, 'COBADEFFXXX', 'ist', 'SKR03', 'einzelunternehmen')`;
  });

  /** Gebuchter Beleg aus einer E-Rechnung mit Skonto; mit `entnahme` trägt die Aufteilung zwei Entnahmezeilen */
  async function bookedDocument(options: { entnahme: boolean }) {
    counter++;
    const { id } = await documents.uploadDocument(actor, { bytes: einvoice(), filename: `RE-2026-${counter}.xml` });
    await documents.updateDocument(actor, id, {
      supplierName: "Netzwerk Hosting GmbH",
      supplierUstId: "DE987654321",
      invoiceNumber: `RE-2026/${counter}`,
      documentDate: "2026-09-15",
      dueDate: "2026-09-29",
      category: "sonstiges",
      payment: "bank",
      note: "",
      amounts: [{ taxRate: 1900, net: 4_213, tax: 801 }],
      ...(options.entnahme
        ? {
            splits: [
              { category: "internet" as const, taxRate: 1900 as const, net: 2_520 },
              { category: "privatentnahme" as const, taxRate: 1900 as const, net: 840 },
              { category: "telefon" as const, taxRate: 1900 as const, net: 512 },
              { category: "privatentnahme" as const, taxRate: 1900 as const, net: 341 },
            ],
          }
        : {}),
    } as Parameters<typeof documents.updateDocument>[2]);
    await documents.bookDocument(actor, id);
    // Ohne Kontakt mit IBAN gilt die der E-Rechnung erst nach ausdrücklicher Bestätigung am Beleg (#410)
    await bank.decideDocumentIban(actor, id, { wahl: "e-rechnung", kontaktIban: null, rechnungsIban: SUPPLIER_IBAN });
    return id;
  }

  const candidate = async (documentId: string) => (await bank.transferCandidates()).find((c) => c.documentId === documentId);

  it("bietet kein Skonto auf einen Beleg mit Entnahmezeile an; die Ausbuchung lehnt mit demselben Grund ab", async () => {
    const mitEntnahme = await bookedDocument({ entnahme: true });
    expect((await candidate(mitEntnahme))?.skontoTerms).toEqual([]);
    await expect(bank.writeOff(actor, { kind: "skontoErhalten", documentId: mitEntnahme, date: "2026-09-16" })).rejects.toThrow(
      "Skonto auf Belege mit Privatanteil wird nicht unterstützt.",
    );
    // Auch die Datei entsteht nicht: Der Beleg bietet das Skonto nicht an
    const { id: accountId } = await bank.createAccount(actor, { name: "Geschäftskonto", iban: ACCOUNT_IBAN });
    await expect(
      bank.createSepaTransfer(actor, { bankAccountId: accountId, executionDate: "2026-09-17", items: [{ documentId: mitEntnahme, skonto: true }] }, now),
    ).rejects.toThrow("Skonto ist zum Ausführungsdatum nicht mehr möglich");
    expect(await sql`select 1 from sepa_transfers`).toHaveLength(0);
  }, 60_000);

  it("lässt das Skonto ohne Entnahmezeile im Angebot und bucht es aus", async () => {
    const ohneEntnahme = await bookedDocument({ entnahme: false });
    expect((await candidate(ohneEntnahme))?.skontoTerms).toEqual([
      { days: 7, percent: 200 },
      { days: 14, percent: 100 },
    ]);
    await bank.writeOff(actor, { kind: "skontoErhalten", documentId: ohneEntnahme, date: "2026-09-16" });
    const [writeOff] = await sql`select kind from write_offs where document_id = ${ohneEntnahme}`;
    expect(writeOff).toMatchObject({ kind: "skontoErhalten" });
  }, 60_000);
});
