import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Freie Beschreibung je Zeile einer Aufteilung (#1975, Etappe A): Sie ist nie null, leer ist der leere Text, wird
 * gespeichert und mit den Zeilen ausgeliefert, steckt aber nicht in der Kontierungszeile — Buchung, EÜR und
 * splitIssues lesen sie nicht. Alle Daten sind erfunden.
 */

const KONTEN_SKR03 = { software: "4964", buero: "4930", vorsteuer: "1576", verbindlichkeiten: "1600" };

describe.skipIf(!testDatabaseUrl)("Aufteilung mit Beschreibung (#1975, Postgres)", () => {
  let documents: typeof import("./documents.ts");
  let splits: typeof import("./splits.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  let fileSeq = 0;

  beforeAll(async () => {
    sql = await setupTestDb();
    splits = await import("./splits.ts");
    documents = await import("./documents.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function reset() {
    await leeren(sql)`truncate document_cancellations, vat_returns, write_offs, allocations, bank_transactions, bank_imports, bank_accounts, cash_entries,
      asset_depreciations, assets, journal_lines, journal_entries, document_splits, document_amounts, documents, year_closings, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, versteuerung, kontenrahmen, kleinunternehmer)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'BY', 'soll', 'SKR03', false)`;
  }

  it("Eingabe: freiwillig, getrimmt, leer der leere Text, höchstens 200 Zeichen", () => {
    const zeile = { category: "software" as const, taxRate: 1900 as const, net: 10_000 };
    expect(splits.splitInputSchema.parse(zeile).description).toBe("");
    expect(splits.splitInputSchema.parse({ ...zeile, description: "" }).description).toBe("");
    expect(splits.splitInputSchema.parse({ ...zeile, description: "   " }).description).toBe("");
    // null ist kein gültiger Zustand der Spalte: not null default '' ist die abgestimmte Form (#1975)
    expect(() => splits.splitInputSchema.parse({ ...zeile, description: null })).toThrow();
    expect(splits.splitInputSchema.parse({ ...zeile, description: "  Lizenzen  " }).description).toBe("Lizenzen");
    expect(splits.splitInputSchema.parse({ ...zeile, description: "x".repeat(200) }).description).toHaveLength(200);
    expect(() => splits.splitInputSchema.parse({ ...zeile, description: "x".repeat(201) })).toThrow();
  });

  it("Kontierungszeile: splitLines liefert dieselben Zeilen mit und ohne Beschreibung", () => {
    const mit = [
      { category: "software" as const, taxRate: 1900 as const, net: 10_000, tax: 1_900, description: "Lizenzen" },
      { category: "buero" as const, taxRate: 1900 as const, net: 7_000, tax: 1_330, description: "" },
    ];
    const ohne = mit.map(({ description: _beschreibung, ...zeile }) => zeile);
    expect(splits.splitLines(mit)).toEqual(splits.splitLines(ohne));
    expect(splits.splitLines(mit)).toEqual([
      { category: "software", taxRate: 1900, net: 10_000, tax: 1_900 },
      { category: "buero", taxRate: 1900, net: 7_000, tax: 1_330 },
    ]);
  });

  /** Ein Beleg mit zwei Zeilen zu 19 %: 100 € Software mit Beschreibung, 70 € Bürobedarf ohne */
  async function belegMitBeschreibung() {
    fileSeq++;
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, fileSeq % 256, Math.floor(fileSeq / 256), 71]);
    const { id } = await documents.uploadDocument(actor, { bytes, filename: `aufteilung-${fileSeq}.jpg` });
    await documents.updateDocument(actor, id, {
      supplierName: "Bürohaus Nord GmbH",
      supplierUstId: "",
      invoiceNumber: `BN-${fileSeq}`,
      documentDate: "2026-09-15",
      dueDate: null,
      category: "sonstiges",
      payment: "bank",
      note: "",
      privateShare: 0,
      reverseCharge: null,
      currency: "EUR",
      exchangeRate: null,
      amounts: [{ taxRate: 1900, net: 17_000, tax: 3_230 }],
      splits: [
        { category: "software", taxRate: 1900, net: 10_000, description: "  Lizenzen  " },
        { category: "buero", taxRate: 1900, net: 7_000 },
      ],
    });
    return id;
  }

  it("speichert die Beschreibung je Zeile, die Zeile ohne bleibt leer, und bucht wie ohne Beschreibung", async () => {
    await reset();
    const id = await belegMitBeschreibung();

    // Die Belegseite liest die Zeilen über getDocument (#1975: der Lader gibt die Beschreibung mit, die Anzeige in
    // -beleg-felder.ts lässt sie noch fallen — das ist Etappe B)
    const gelesen = (await documents.getDocument(id))!;
    expect(gelesen.splits.map(({ position, category, taxRate, net, tax, description }) => ({ position, category, taxRate, net, tax, description }))).toEqual([
      { position: 1, category: "software", taxRate: 1900, net: 10_000, tax: 1_900, description: "Lizenzen" },
      { position: 2, category: "buero", taxRate: 1900, net: 7_000, tax: 1_330, description: "" },
    ]);

    // Die Kontierungszeilen sind die von vorher: Kategorie, Satz, Netto, Steuer — keine Beschreibung
    expect(splits.splitLines(gelesen.splits)).toEqual([
      { category: "software", taxRate: 1900, net: 10_000, tax: 1_900 },
      { category: "buero", taxRate: 1900, net: 7_000, tax: 1_330 },
    ]);

    // Gebucht wird über Konto und Betrag; die Beschreibung ändert keine Buchungszeile
    await documents.bookDocument(actor, id);
    const zeilen = await sql`select l.account, l.debit, l.credit, l.tax_code from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.source_type = 'document' and e.source_id = ${id} and e.reverses_id is null order by l.account`;
    expect([...zeilen].map(({ account, debit, credit, tax_code }) => ({ account, debit, credit, tax_code }))).toEqual([
      { account: KONTEN_SKR03.vorsteuer, debit: 3_230, credit: 0, tax_code: "VSt19" },
      { account: KONTEN_SKR03.verbindlichkeiten, debit: 0, credit: 20_230, tax_code: null },
      { account: KONTEN_SKR03.buero, debit: 7_000, credit: 0, tax_code: "VSt19" },
      { account: KONTEN_SKR03.software, debit: 10_000, credit: 0, tax_code: "VSt19" },
    ]);
  });
});
