import { readFileSync } from "node:fs";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Migration 0340 (#1975, docs/adr/belege-positionen.md): Offene Belege aus der Zeit vor den Positionen, mit Kategorie,
 * eigenem Konto und Privatanteil am Beleg, werden zu Positionen. Bedingung: Jede Buchung ergibt danach auf jedem Konto
 * (mit Steuerschlüssel und Bemessungsgrundlage) dasselbe wie vorher.
 *
 * Je Fall entstehen zwei gleiche Entwürfe im Stand der bisherigen Version: Kategorie, Konto und Privatanteil am Beleg,
 * keine Positionen. Der erste wird so gebucht, wie Haben einen solchen Beleg bucht (Kategorie und Prozentsatz, wie vor dem
 * Update); danach läuft die Migration, die nur den zweiten, offenen Beleg umstellt, und er wird aus seinen Positionen
 * gebucht. Verglichen werden beide Buchungen Konto für Konto.
 */

const MIGRATION = readFileSync(new URL("../../../../drizzle/0340_belege_positionen.sql", import.meta.url), "utf8");

type Fall = {
  name: string;
  category: string;
  privateShare?: number;
  amounts: { taxRate: 1900 | 700 | 0; net: number; tax: number; originalNet?: number; originalTax?: number; vorsteuerAnteil?: number | null }[];
  extra?: Record<string, unknown>;
  eigenesKonto?: boolean;
};

const FAELLE: Fall[] = [
  {
    // Das Telefon-Beispiel aus #1975: Internet 33,60 € netto zu 25 % privat
    name: "Privatanteil 25 % (Internet)",
    category: "internet",
    privateShare: 25,
    amounts: [{ taxRate: 1900, net: 3_360, tax: 638 }],
  },
  {
    // Je Position nach Netto verteilt bekäme die Entnahme 0,47 € statt 0,48 € Steuer; die Migration rundet wie der Beleg
    name: "Privatanteil mit halbem Cent in der Steuer",
    category: "telefon",
    privateShare: 25,
    amounts: [{ taxRate: 1900, net: 1_001, tax: 190 }],
  },
  {
    name: "Privatanteil 40 % über zwei Sätze, privat bezahlt",
    category: "telefon",
    privateShare: 40,
    amounts: [
      { taxRate: 1900, net: 853, tax: 162 },
      { taxRate: 700, net: 1_999, tax: 140 },
    ],
    extra: { payment: "privat" },
  },
  { name: "Bewirtung (70 % abziehbar, gebucht über die Kategorie)", category: "bewirtung", amounts: [{ taxRate: 1900, net: 8_403, tax: 1_597 }] },
  {
    name: "Fremdwährung mit Privatanteil",
    category: "software",
    privateShare: 20,
    amounts: [{ taxRate: 0, net: 0, tax: 0, originalNet: 9_999, originalTax: 0 }],
    extra: { currency: "USD", exchangeRate: "1,0812" },
  },
  {
    name: "§ 13b mit Privatanteil",
    category: "fremdleistung",
    privateShare: 30,
    amounts: [{ taxRate: 1900, net: 10_001, tax: 1_900 }],
    extra: { reverseCharge: "eu" },
  },
  {
    name: "Vorsteueranteil § 15 Abs. 4 mit Privatanteil",
    category: "sonstiges",
    privateShare: 10,
    amounts: [{ taxRate: 1900, net: 12_345, tax: 2_346, vorsteuerAnteil: 6_000 }],
  },
  { name: "Gutschrift mit Privatanteil", category: "telefon", privateShare: 25, amounts: [{ taxRate: 1900, net: -1_001, tax: -190 }] },
  {
    name: "Innergemeinschaftlicher Erwerb mit Privatanteil",
    category: "buero",
    privateShare: 50,
    amounts: [{ taxRate: 700, net: 5_001, tax: 350 }],
    extra: { reverseCharge: "ig_erwerb", supplierUstId: "NL123456789B01" },
  },
  { name: "Eigenes Konto", category: "software", amounts: [{ taxRate: 1900, net: 10_000, tax: 1_900 }], eigenesKonto: true },
  {
    name: "Anlage",
    category: "anlage",
    amounts: [{ taxRate: 1900, net: 150_000, tax: 28_500 }],
    extra: { asset: { name: "Rechner", kind: "edv", method: "digital", usefulLifeMonths: null } },
  },
  { name: "Einfuhrumsatzsteuer", category: "einfuhrumsatzsteuer", amounts: [{ taxRate: 0, net: 1_234, tax: 0 }] },
  // 1 % von 0,20 € ergibt 0 Cent: keine Entnahme, eine Position
  { name: "Privatanteil ohne Cent", category: "telefon", privateShare: 1, amounts: [{ taxRate: 700, net: 20, tax: 1 }] },
];

const EIGENES_KONTO = { SKR03: "4999", SKR04: "6999" } as const;

describe.skipIf(!testDatabaseUrl)("Migration 0340: offene Belege werden Positionen, ihre Buchung bleibt (Postgres, #1975)", () => {
  let documents: typeof import("./documents.ts");
  let konten: typeof import("../eigene-konten/index.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  let fileSeq = 0;

  beforeAll(async () => {
    sql = await setupTestDb();
    documents = await import("./documents.ts");
    konten = await import("../eigene-konten/index.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function reset(kontenrahmen: "SKR03" | "SKR04", versteuerung: "ist" | "soll") {
    await leeren(sql)`truncate document_cancellations, vat_returns, write_offs, allocations, cash_entries, asset_depreciations, assets,
      journal_lines, journal_entries, document_splits, document_amounts, documents, own_accounts, exchange_rates, year_closings, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, versteuerung, kontenrahmen, kleinunternehmer)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'BY', ${versteuerung}, ${kontenrahmen}, false)`;
    return konten.createOwnAccount(actor, { account: EIGENES_KONTO[kontenrahmen], name: "Software: Entwicklung", parentCategory: "software" });
  }

  /** Ein Entwurf im Stand vor dem Update: Kategorie, Konto und Privatanteil am Beleg, keine Positionen */
  async function altEntwurf(fall: Fall, eigenesKonto: string): Promise<string> {
    fileSeq++;
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, fileSeq % 256, Math.floor(fileSeq / 256), 40]);
    const { id } = await documents.uploadDocument(actor, { bytes, filename: `alt-${fileSeq}.jpg` });
    const ownAccountId = fall.eigenesKonto ? eigenesKonto : null;
    await documents.updateDocument(actor, id, {
      supplierName: "Lieferant GmbH",
      supplierUstId: "",
      invoiceNumber: `L-${fileSeq}`,
      documentDate: "2026-09-15",
      dueDate: null,
      category: fall.category,
      ownAccountId,
      payment: "bank",
      note: "",
      privateShare: 0,
      amounts: fall.amounts,
      ...fall.extra,
    } as never);
    // Zurück in die Form der bisherigen Version: die Kontierung am Beleg, ohne Positionen
    await sql`delete from document_splits where document_id = ${id}`;
    await sql`update documents set category = ${fall.category}, own_account_id = ${ownAccountId}, private_share = ${fall.privateShare ?? 0} where id = ${id}`;
    return id;
  }

  /** Salden der Buchung je Konto und Steuerschlüssel, dazu die Bemessungsgrundlage */
  async function salden(id: string) {
    const rows = await sql<{ account: string; tax_code: string | null; saldo: number; basis: number }[]>`
      select l.account, l.tax_code, sum(l.debit - l.credit)::int as saldo, coalesce(sum(l.basis), 0)::int as basis
        from journal_lines l join journal_entries e on e.id = l.entry_id
       where e.source_type = 'document' and e.source_id = ${id} and e.reverses_id is null
       group by l.account, l.tax_code order by l.account, l.tax_code`;
    return rows.map((r) => ({ ...r })).filter((r) => r.saldo !== 0 || r.basis !== 0);
  }

  async function migrieren() {
    await sql.begin(async (tx) => {
      for (const statement of MIGRATION.split("--> statement-breakpoint")) await tx.unsafe(statement);
    });
  }

  for (const [kontenrahmen, versteuerung] of [
    ["SKR03", "soll"],
    ["SKR03", "ist"],
    ["SKR04", "soll"],
    ["SKR04", "ist"],
  ] as const) {
    it(`${kontenrahmen}, ${versteuerung}: jede Buchung bleibt Konto für Konto gleich`, async () => {
      const eigenesKonto = await reset(kontenrahmen, versteuerung);
      const paare = [];
      for (const fall of FAELLE) paare.push({ fall, vorher: await altEntwurf(fall, eigenesKonto), nachher: await altEntwurf(fall, eigenesKonto) });
      for (const { vorher } of paare) await documents.bookDocument(actor, vorher);

      await migrieren();

      for (const { fall, vorher, nachher } of paare) {
        const [doc] = await sql`select category, own_account_id, private_share from documents where id = ${nachher}`;
        expect(doc, fall.name).toEqual({ category: null, own_account_id: null, private_share: 0 });
        // Der gebuchte Beleg bleibt, wie er ist: Kategorie am Beleg, keine Positionen
        expect(await sql`select count(*)::int as n from document_splits where document_id = ${vorher}`, fall.name).toEqual([{ n: 0 }]);
        await documents.bookDocument(actor, nachher);
        const erwartet = await salden(vorher);
        expect(erwartet.length, fall.name).toBeGreaterThan(0);
        expect(await salden(nachher), fall.name).toEqual(erwartet);
      }
    }, 120_000);
  }

  it("spaltet den Privatanteil je Satz als Position ab, mit dem Netto laut Beleg bei Fremdwährung", async () => {
    const eigenesKonto = await reset("SKR03", "soll");
    const telefon = await altEntwurf(FAELLE[2]!, eigenesKonto);
    const usd = await altEntwurf(FAELLE[4]!, eigenesKonto);
    await migrieren();
    const positionen = (id: string) =>
      sql`select position, category, tax_rate, net, tax, original_net::int as original_net from document_splits where document_id = ${id} order by position`;
    expect(await positionen(telefon)).toEqual([
      { position: 1, category: "telefon", tax_rate: 1900, net: 512, tax: 97, original_net: null },
      { position: 2, category: "privatentnahme", tax_rate: 1900, net: 341, tax: 65, original_net: null },
      { position: 3, category: "telefon", tax_rate: 700, net: 1_199, tax: 84, original_net: null },
      { position: 4, category: "privatentnahme", tax_rate: 700, net: 800, tax: 56, original_net: null },
    ]);
    // 99,99 USD zum Kurs 1,0812 sind 92,48 €; 20 % privat
    expect(await positionen(usd)).toEqual([
      { position: 1, category: "software", tax_rate: 0, net: 7_398, tax: 0, original_net: 7_999 },
      { position: 2, category: "privatentnahme", tax_rate: 0, net: 1_850, tax: 0, original_net: 2_000 },
    ]);
  });

  it("lässt gebuchte und schon aufgeteilte Belege unberührt und hält die Hash-Kette", async () => {
    const eigenesKonto = await reset("SKR04", "ist");
    const gebucht = await altEntwurf(FAELLE[0]!, eigenesKonto);
    await documents.bookDocument(actor, gebucht);
    const aufgeteilt = await altEntwurf(FAELLE[0]!, eigenesKonto);
    await sql`update documents set category = null, private_share = 0 where id = ${aufgeteilt}`;
    await sql`insert into document_splits (document_id, position, category, tax_rate, net, tax)
      values (${aufgeteilt}, 1, 'internet', 1900, 2000, 380), (${aufgeteilt}, 2, 'telefon', 1900, 1360, 258)`;
    const vorher = await sql`select * from document_splits order by document_id, position`;
    await migrieren();
    expect(await sql`select * from document_splits order by document_id, position`).toEqual(vorher);
    expect(await sql`select category, private_share from documents where id = ${gebucht}`).toEqual([{ category: "internet", private_share: 25 }]);
    // Nur die Belege dieses Falls: die Siegel der Fälle davor zeigen nach dem Leeren der Tabellen auf nichts mehr
    expect(await sql`select art, befund from haben_integrity_problems(100) where zeile in (${gebucht}, ${aufgeteilt})`).toEqual([]);
  });
});
