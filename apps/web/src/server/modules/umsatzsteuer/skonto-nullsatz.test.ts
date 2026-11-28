import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Eingangsbeleg mit 7 % und 0 % und erhaltenem Skonto (#2033, § 17 Abs. 1 Satz 2 UStG):
 * gebuchteSkontoSteuer (vorsteuer-belege.ts) und skontoVorsteuer (skonto-vorsteuer.ts) dürfen
 * 0-%-Posten nicht über `rate === 1900 ? "VSt19" : "VSt7"` auf VSt7 abbilden.
 */

function dkbCsv(rows: string[][]) {
  const header = `"Girokonto";"DE12 1203 0000 1234 5678 90"\n""\n`;
  const columns = `"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"\n`;
  return new TextEncoder().encode(`${header + columns + rows.map((r) => r.map((c) => `"${c}"`).join(";")).join("\n")}\n`);
}

const euro = (cents: number) => `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)},${String(Math.abs(cents) % 100).padStart(2, "0")}`;

describe.skipIf(!testDatabaseUrl)("Erhaltenes Skonto bei Beleg mit 7 % und 0 % (Postgres, #2033)", () => {
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

  async function belegBuchen(amounts: { taxRate: number; net: number; tax: number }[]) {
    seq++;
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, seq % 256, Math.floor(seq / 256), 77]);
    const { id } = await documents.uploadDocument(actor, { bytes, filename: `skonto-nullsatz-${seq}.jpg` });
    await documents.updateDocument(actor, id, {
      supplierName: "Musterlieferant GmbH",
      supplierUstId: "",
      invoiceNumber: `SK-${seq}`,
      documentDate: "2026-09-10",
      dueDate: null,
      category: "sonstiges",
      payment: "bank",
      note: "",
      privateShare: 0,
      reverseCharge: null,
      currency: "EUR",
      exchangeRate: null,
      amounts,
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
          [datum, datum, "Gebucht", "Testfirma", "Musterlieferant GmbH", `SK ${seq}`, "Ausgang", "DE02100100100006820101", euro(cents), "", "", ""],
        ]),
        filename: `skonto-nullsatz-konto-${seq}.csv`,
      },
      null,
    );
    const [tx] = await sql`select id, amount from bank_transactions order by created_at desc limit 1`;
    await bank.allocate(actor, { kind: "document", transactionId: tx!.id as string, documentId, amount: tx!.amount as number });
  }

  it("SKR03, Ist: 19 %/7 %/0 % mit erhaltenem Skonto erzeugt keine 0-%-Zeile in inputTax und stimmt mit Kz 66 überein", async () => {
    await reset("SKR03", "ist");
    const id = await belegBuchen([
      { taxRate: 1900, net: 5_000, tax: 950 },
      { taxRate: 700, net: 3_000, tax: 210 },
      { taxRate: 0, net: 9_000, tax: 0 },
    ]);
    await zuordnen(id, "15.09.26", -17_060);
    await bank.writeOff(actor, { kind: "skontoErhalten", documentId: id, date: "2026-09-15" });

    const sep = await vat.computeVatFigures({ year: 2026, month: 9 });
    expect(sep.inputTax.filter((z) => z.rate === 0)).toEqual([]);
    expect(sep.inputTax.reduce((s, z) => s + z.tax, 0)).toBe(sep.kz66);
    expect((await abgleich.vatAbgleich({ year: 2026, month: 9 })).zeilen.filter((z) => z.journal !== z.quelle)).toEqual([]);
    expect((await abgleich.euerAbgleich(2026)).zeilen.filter((z) => z.journal !== z.quelle)).toEqual([]);
  });

  it("SKR04, Soll: zwei Skonto-Ausbuchungen auf Beleg mit 7 % und 0 % buchen keine 0-%-Vorsteuer und stimmen mit Kz 66 überein", async () => {
    await reset("SKR04", "soll");
    const id = await belegBuchen([
      { taxRate: 700, net: 10_000, tax: 700 },
      { taxRate: 0, net: 10_000, tax: 0 },
    ]);
    await zuordnen(id, "15.09.26", -19_700);
    await bank.writeOff(actor, { kind: "skontoErhalten", documentId: id, date: "2026-09-15", amount: -500 });
    await bank.writeOff(actor, { kind: "skontoErhalten", documentId: id, date: "2026-09-16", amount: -500 });

    const sep = await vat.computeVatFigures({ year: 2026, month: 9 });
    expect(sep.inputTax.filter((z) => z.rate === 0)).toEqual([]);
    expect(sep.inputTax.reduce((s, z) => s + z.tax, 0)).toBe(sep.kz66);
    expect((await abgleich.vatAbgleich({ year: 2026, month: 9 })).zeilen.filter((z) => z.journal !== z.quelle)).toEqual([]);
    expect((await abgleich.euerAbgleich(2026)).zeilen.filter((z) => z.journal !== z.quelle)).toEqual([]);
  });
});
