import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Beleg mit drei Steuersätzen (19 %, 7 %, 0 % als größter Posten) und Teilzahlung (#2026):
 * paidTaxShares darf den Steuer-Rundungsrest nicht auf den 0-%-Satz legen; sonst scheitert
 * freigabeNachziehen beim Leistungsdatum im Folgemonat im Saldo-Trigger (0 Zeilen), und bei
 * einer Gutschrift „erstattet bereits Bezahltes“ steht ein 0-%-Steuerposten in der Erläuterung.
 */

function dkbCsv(rows: string[][]) {
  const header = `"Girokonto";"DE12 1203 0000 1234 5678 90"\n""\n`;
  const columns = `"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"\n`;
  return new TextEncoder().encode(`${header + columns + rows.map((r) => r.map((c) => `"${c}"`).join(";")).join("\n")}\n`);
}

const euro = (cents: number) => `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)},${String(Math.abs(cents) % 100).padStart(2, "0")}`;

describe.skipIf(!testDatabaseUrl)("Teilzahlung mit 0-%-Satz als größtem Posten (Postgres, #2026)", () => {
  let documents: typeof import("../belege/index.ts");
  let bank: typeof import("../bank/index.ts");
  let vat: typeof import("./index.ts");
  let abgleich: typeof import("../auswertungen/abgleich.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  let seq = 0;

  beforeAll(async () => {
    sql = await setupTestDb();
    documents = await import("../belege/index.ts");
    bank = await import("../bank/index.ts");
    vat = await import("./index.ts");
    abgleich = await import("../auswertungen/abgleich.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function reset(kontenrahmen: "SKR03" | "SKR04", versteuerung: "ist" | "soll") {
    await leeren(sql)`truncate document_cancellations, document_settlements, vat_returns, write_offs, allocations, bank_transactions, bank_imports,
      bank_accounts, cash_entries, journal_lines, journal_entries, document_splits, document_amounts, documents, year_closings, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, versteuerung, kontenrahmen, rechtsform)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'BY', ${versteuerung}, ${kontenrahmen}, 'einzelunternehmen')`;
  }

  async function belegBuchen(input: Record<string, unknown>) {
    seq++;
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, seq % 256, Math.floor(seq / 256), 42]);
    const { id } = await documents.uploadDocument(actor, { bytes, filename: `nullsatz-${seq}.jpg` });
    await documents.updateDocument(actor, id, {
      supplierName: "Musterlieferant GmbH",
      supplierUstId: "",
      invoiceNumber: `NS-${seq}`,
      documentDate: "2026-09-15",
      dueDate: null,
      category: "sonstiges",
      payment: "bank",
      note: "",
      privateShare: 0,
      reverseCharge: null,
      currency: "EUR",
      exchangeRate: null,
      ...input,
    } as Parameters<typeof documents.updateDocument>[2]);
    await documents.bookDocument(actor, id);
    return id;
  }

  async function zuordnen(documentId: string, datum: string, cents: number) {
    seq++;
    await bank.importStatement(
      actor,
      {
        bytes: dkbCsv([
          [
            datum,
            datum,
            "Gebucht",
            "Testfirma",
            "Musterlieferant GmbH",
            `NS ${seq}`,
            cents < 0 ? "Ausgang" : "Eingang",
            "DE02100100100006820101",
            euro(cents),
            "",
            "",
            "",
          ],
        ]),
        filename: `nullsatz-konto-${seq}.csv`,
      },
      null,
    );
    const [tx] = await sql`select id, amount from bank_transactions order by created_at desc limit 1`;
    await bank.allocate(actor, { kind: "document", transactionId: tx!.id as string, documentId, amount: tx!.amount as number });
  }

  it("SKR03, Ist: Leistungsdatum im Folgemonat + Teilzahlung 11,00 € bucht ohne Saldo-Trigger-Fehler und mit Kz 66 = 70 ct", async () => {
    await reset("SKR03", "ist");
    const id = await belegBuchen({
      serviceFrom: "2026-10-01",
      serviceTo: "2026-10-31",
      amounts: [
        { taxRate: 1900, net: 5_000, tax: 950 },
        { taxRate: 700, net: 3_000, tax: 210 },
        { taxRate: 0, net: 9_000, tax: 0 },
      ],
    });
    // 11,00 € auf 181,60 € brutto → 70 ct Steuer; ohne Fix landet −1 ct auf 0 % und freigabeNachziehen scheitert mit 0 Zeilen
    await zuordnen(id, "20.09.26", -1_100);
    const sep = await vat.computeVatFigures({ year: 2026, month: 9 });
    expect(sep.inputTax.filter((z) => z.rate === 0)).toEqual([]);
    expect({ kz66: sep.kz66, erlaeuterung: sep.inputTax.reduce((s, z) => s + z.tax, 0) }).toEqual({ kz66: 70, erlaeuterung: 70 });
    expect((await abgleich.vatAbgleich({ year: 2026, month: 9 })).zeilen.filter((z) => z.journal !== z.quelle)).toEqual([]);
    expect((await abgleich.euerAbgleich(2026)).zeilen.filter((z) => z.journal !== z.quelle)).toEqual([]);

    // Restzahlung im Monat der Ausführung: Zwischenkonto 1548 endet bei 0, Oktober trägt die übrigen 10,90 €
    await zuordnen(id, "20.10.26", -17_060);
    const okt = await vat.computeVatFigures({ year: 2026, month: 10 });
    expect({ kz66: okt.kz66, erlaeuterung: okt.inputTax.reduce((s, z) => s + z.tax, 0) }).toEqual({ kz66: 1_090, erlaeuterung: 1_090 });
    const [zwischen] = await sql`select coalesce(sum(debit - credit), 0)::int as saldo from journal_lines where account = '1548'`;
    expect(zwischen?.saldo).toBe(0);
    expect((await abgleich.vatAbgleich({ year: 2026, month: 10 })).zeilen.filter((z) => z.journal !== z.quelle)).toEqual([]);
    expect((await abgleich.euerAbgleich(2026)).zeilen.filter((z) => z.journal !== z.quelle)).toEqual([]);
  });

  it("SKR04, Soll: Gutschrift erstattetBezahltes + Teilerstattung 11,00 € hat keine 0-%-Zeile in der Erläuterung und Kz 66 = −70 ct", async () => {
    await reset("SKR04", "soll");
    const id = await belegBuchen({
      erstattetBezahltes: true,
      amounts: [
        { taxRate: 1900, net: -5_000, tax: -950 },
        { taxRate: 700, net: -3_000, tax: -210 },
        { taxRate: 0, net: -9_000, tax: 0 },
      ],
    });
    await zuordnen(id, "20.09.26", 1_100);
    const sep = await vat.computeVatFigures({ year: 2026, month: 9 });
    expect(sep.inputTax.filter((z) => z.rate === 0)).toEqual([]);
    expect({ kz66: sep.kz66, erlaeuterung: sep.inputTax.reduce((s, z) => s + z.tax, 0) }).toEqual({ kz66: -70, erlaeuterung: -70 });
    expect((await abgleich.vatAbgleich({ year: 2026, month: 9 })).zeilen.filter((z) => z.journal !== z.quelle)).toEqual([]);
    expect((await abgleich.euerAbgleich(2026)).zeilen.filter((z) => z.journal !== z.quelle)).toEqual([]);

    // Resterstattung: Zwischenkonto 1434 endet bei 0
    await zuordnen(id, "20.10.26", 17_060);
    const okt = await vat.computeVatFigures({ year: 2026, month: 10 });
    expect({ kz66: okt.kz66, erlaeuterung: okt.inputTax.reduce((s, z) => s + z.tax, 0) }).toEqual({ kz66: -1_090, erlaeuterung: -1_090 });
    const [zwischen] = await sql`select coalesce(sum(debit - credit), 0)::int as saldo from journal_lines where account = '1434'`;
    expect(zwischen?.saldo).toBe(0);
    expect((await abgleich.vatAbgleich({ year: 2026, month: 10 })).zeilen.filter((z) => z.journal !== z.quelle)).toEqual([]);
    expect((await abgleich.euerAbgleich(2026)).zeilen.filter((z) => z.journal !== z.quelle)).toEqual([]);
  });
});
