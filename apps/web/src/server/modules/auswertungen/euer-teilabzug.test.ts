import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

function dkbCsv(date: string, amount: string) {
  const columns = [
    "Buchungsdatum",
    "Wertstellung",
    "Status",
    "Zahlungspflichtige*r",
    "Zahlungsempfänger*in",
    "Verwendungszweck",
    "Umsatztyp",
    "IBAN",
    "Betrag (€)",
    "Gläubiger-ID",
    "Mandatsreferenz",
    "Kundenreferenz",
  ];
  const row = [date, date, "Gebucht", "Testfirma", "Lieferant", "Testzahlung", "Ausgang", "DE02100100100006820101", amount, "", "", ""];
  const csvRow = (cells: string[]) => cells.map((c) => `"${c}"`).join(";");
  return new TextEncoder().encode(`"Girokonto";"DE12 1203 0000 1234 5678 90"\n""\n${csvRow(columns)}\n${csvRow(row)}\n`);
}

describe.skipIf(!testDatabaseUrl)("EÜR-Teilabzug: Journal und Nebenbücher (Postgres, #433)", () => {
  let sql: postgres.Sql;
  let documents: typeof import("../belege/documents.ts");
  let bank: typeof import("../bank/index.ts");
  let reports: typeof import("./reports.ts");
  let quelle: typeof import("./euer-quelle.ts");
  let abgleich: typeof import("./abgleich.ts");
  let db: typeof import("../../db/index.ts").db;
  const actor = "euer-teilabzug-test";
  let seq = 0;

  beforeAll(async () => {
    sql = await setupTestDb();
    db = (await import("../../db/index.ts")).db;
    documents = await import("../belege/documents.ts");
    bank = await import("../bank/index.ts");
    reports = await import("./reports.ts");
    quelle = await import("./euer-quelle.ts");
    abgleich = await import("./abgleich.ts");
  }, 30_000);
  afterAll(async () => {
    await sql?.end();
  });

  async function reset(kr: "SKR03" | "SKR04", art: "ist" | "soll") {
    await leeren(sql)`truncate document_cancellations, document_settlements, vat_returns, write_offs, allocations,
      bank_transactions, bank_imports, bank_accounts, cash_entries, asset_depreciations, assets, journal_lines,
      journal_entries, document_splits, document_amounts, documents, year_closings, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, versteuerung, kontenrahmen)
      values (1, 'Testfirma', 'Testweg 1', '93047', 'Regensburg', 'test@example.com', '198/113/10010', 'BY', ${art}, ${kr})`;
  }

  type Amount = { taxRate: 1900 | 700 | 0; net: number; tax: number; vorsteuerAnteil?: number | null };
  async function book(
    options: {
      amounts?: Amount[];
      vorsteuerAnteil?: number;
      privateShare?: number;
      payment?: "bank" | "privat";
      reverseCharge?: "eu" | "ig_erwerb";
      splits?: { category: "telefon" | "internet" | "software" | "buero"; taxRate: 1900 | 700 | 0; net: number; privateShare?: number }[];
    } = {},
  ) {
    seq++;
    const { id } = await documents.uploadDocument(actor, {
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, seq % 256, Math.floor(seq / 256), 27]),
      filename: `euer-teil-${seq}.jpg`,
    });
    await documents.updateDocument(actor, id, {
      supplierName: "Lieferant",
      supplierUstId: options.reverseCharge === "ig_erwerb" ? "ATU12345675" : "",
      invoiceNumber: `ET-${seq}`,
      documentDate: "2026-09-15",
      dueDate: null,
      category: "software",
      note: "",
      payment: options.payment ?? "bank",
      vorsteuerAnteil: options.vorsteuerAnteil ?? 5_000,
      privateShare: options.privateShare ?? 0,
      reverseCharge: options.reverseCharge ?? null,
      amounts: options.amounts ?? [{ taxRate: 1900, net: 10_000, tax: 1_900 }],
      ...(options.splits ? { splits: options.splits } : {}),
    });
    await documents.bookDocument(actor, id);
    return id;
  }

  async function transaction(date: string, amount: string) {
    await bank.importStatement(actor, { bytes: dkbCsv(date, amount), filename: `zahlung-${seq}-${date}-${amount}.csv` }, null);
    const [row] = await sql<{ id: string; amount: number }[]>`select id, amount from bank_transactions order by created_at desc limit 1`;
    return row!;
  }

  const amount = (euer: Awaited<ReturnType<typeof reports.euerForYear>>, key: string) =>
    [...euer.einnahmen, ...euer.ausgaben].find((l) => l.key === key)?.amount ?? 0;

  async function compare(year: number, expense: number, vorsteuer: number) {
    for (const euer of [await quelle.euerAusDemJournal(year, db)]) {
      expect(amount(euer, "ausgabe:software")).toBe(expense);
      expect(amount(euer, "vorsteuer")).toBe(vorsteuer);
    }
    expect(abgleich.abweichungen((await abgleich.euerAbgleich(year)).zeilen)).toEqual([]);
  }

  it("SKR03, Ist: gespeicherte Satzanteile mit Privatanteil gelten auch nach Änderung der Firmenvorgabe", async () => {
    await reset("SKR03", "ist");
    await book({
      payment: "privat",
      privateShare: 20,
      amounts: [
        { taxRate: 1900, net: 10_000, tax: 1_900, vorsteuerAnteil: 2_500 },
        { taxRate: 700, net: 10_000, tax: 700, vorsteuerAnteil: null },
      ],
    });
    await sql`update company set ohne_vorsteuerabzug=true`;
    // Geschäftlich 16.000 + 2.080 Steuer; 25 % von 1.520 + 50 % von 560 sind 660 Cent.
    await compare(2026, 17_420, 660);
  });

  it("SKR04, Soll: zwei Teilzahlungen über den Jahreswechsel verwenden denselben gespeicherten Abzug", async () => {
    await reset("SKR04", "soll");
    const id = await book();
    const erste = await transaction("20.09.26", "-59,50");
    await bank.allocate(actor, { kind: "document", documentId: id, transactionId: erste.id, amount: erste.amount });
    const zweite = await transaction("20.01.27", "-59,50");
    await bank.allocate(actor, { kind: "document", documentId: id, transactionId: zweite.id, amount: zweite.amount });
    await compare(2026, 5_475, 475);
    await compare(2027, 5_475, 475);
  });

  it("13 Cent, 50 %: drei Teilzahlungen über den Jahreswechsel verteilen genau 2 Cent Vorsteuer", async () => {
    await reset("SKR04", "soll");
    const id = await book({ amounts: [{ taxRate: 1900, net: 10, tax: 3 }] });
    for (const [date, value] of [
      ["20.09.26", "-0,04"],
      ["20.01.27", "-0,04"],
      ["20.02.27", "-0,05"],
    ]) {
      const t = await transaction(date!, value!);
      await bank.allocate(actor, { kind: "document", documentId: id, transactionId: t.id, amount: t.amount });
    }
    await compare(2026, 3, 1);
    await compare(2027, 8, 1);
    const [erste] = await sql<{ id: string }[]>`select a.id from allocations a join bank_transactions b on b.id=a.transaction_id
      where a.document_id=${id} and a.reverses_id is null order by b.booking_date, a.created_at limit 1`;
    await bank.reverseAllocation(actor, erste!.id);
    await compare(2026, 0, 0);
    await compare(2027, 8, 1);
  });

  it.each(["eu", "ig_erwerb"] as const)("%s: nicht abziehbare Steuer wird erst bei der Finanzamtszahlung EÜR-Ausgabe", async (reverseCharge) => {
    await reset("SKR03", "ist");
    await book({ payment: "privat", reverseCharge });
    await compare(2026, 10_000, 0);
    const zahlung = await transaction("20.10.26", "-9,50");
    await bank.allocate(actor, { kind: "ustVorauszahlung", transactionId: zahlung.id, amount: zahlung.amount });
    const journal = await quelle.euerAusDemJournal(2026, db);
    expect(journal.totalAusgaben).toBe(10_950);
    expect(amount(journal, "gezahlteUst")).toBe(950);
    await compare(2026, 10_000, 0);
  });

  // Review #1924: Bei aufgeteilten Belegen ist der Anteil am Beleg 0, der Privatanteil steht in den Zeilen. Der
  // Nebenbuchpfad übersprang solche Belege bei vollem Vorsteuerabzug, deshalb wich die DATEV-Formel um einen Cent ab.
  for (const [kr, art] of [
    ["SKR03", "ist"],
    ["SKR04", "soll"],
  ] as const) {
    it(`Vodafone-Mischbeleg, zwei Teilzahlungen: DATEV-Formel und EÜR stimmen (${kr}, ${art})`, async () => {
      await reset(kr, art);
      const id = await book({
        vorsteuerAnteil: 10_000,
        amounts: [{ taxRate: 1900, net: 4_213, tax: 801 }],
        splits: [
          { category: "telefon", taxRate: 1900, net: 853, privateShare: 40 },
          { category: "internet", taxRate: 1900, net: 3_360, privateShare: 25 },
        ],
      });
      for (const date of ["24.11.26", "25.11.26"]) {
        const t = await transaction(date, "-16,71");
        await bank.allocate(actor, { kind: "document", documentId: id, transactionId: t.id, amount: t.amount });
      }
      const euer = await reports.euerForYear(2026);
      // Zusammen 20,20 € Aufwand und 3,84 € Vorsteuer; wie die Rundung der Zeilenanteile sie auf Telefon und Internet
      // verteilt, ist offen, der Abgleich hängt an ihrer Summe.
      expect(amount(euer, "ausgabe:telefon") + amount(euer, "ausgabe:internet")).toBe(2_020);
      expect(amount(euer, "vorsteuer")).toBe(384);
      const zeile = (await abgleich.euerAbgleich(2026)).zeilen.find((z) => z.posten === "EÜR: Gewinn nach der DATEV-Formel");
      expect(zeile).toMatchObject({ journal: -2_404, quelle: -2_404 });
      expect(abgleich.abweichungen((await abgleich.euerAbgleich(2026)).zeilen)).toEqual([]);
    }, 60_000);
  }

  // § 13b + Zeilenanteil bleibt beim Belegpfad: Der Nebenbuchpfad setzt die Zeilensteuer für den Zahlbetrag auf 0 und
  // verlöre damit den privaten Teil der selbst geschuldeten Steuer in Zeile 17 (Vorschlag im Review: in euer-beleg.ts).
  it("§ 13b mit Privatanteil je Zeile: Zeile 17 bleibt der private Teil der selbst geschuldeten Steuer", async () => {
    await reset("SKR03", "ist");
    const id = await book({
      vorsteuerAnteil: 10_000,
      reverseCharge: "eu",
      amounts: [{ taxRate: 1900, net: 10_000, tax: 1_900 }],
      splits: [
        { category: "telefon", taxRate: 1900, net: 5_000, privateShare: 25 },
        { category: "internet", taxRate: 1900, net: 5_000, privateShare: 0 },
      ],
    });
    const t = await transaction("24.11.26", "-100,00");
    await bank.allocate(actor, { kind: "document", documentId: id, transactionId: t.id, amount: t.amount });
    const euer = await reports.euerForYear(2026);
    expect(euer.einnahmen.find((l) => l.key === "vereinnahmteUst")?.amount ?? 0).toBe(238);
    expect(abgleich.abweichungen((await abgleich.euerAbgleich(2026)).zeilen)).toEqual([]);
  }, 60_000);
});
