import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Belege aus Positionen (#1975, docs/adr/belege-positionen.md): Jeder Beleg speichert seine Kontierung als Positionen,
 * die Beträge je Satz folgen daraus. Das bisherige Formular schickt weiter Kategorie und Privatanteil und sieht sie
 * unverändert (formularansicht). Telefon-Beispiel aus dem Issue: Internet 33,60 € netto zu 25 % privat, Telefon 8,53 €
 * netto zu 40 % privat; gebucht 30,32 € Aufwand, 5,76 € Vorsteuer, 14,06 € Entnahme.
 */

const KONTEN = {
  SKR03: { internet: "4925", telefon: "4920", buero: "4930", entnahme: "1800", vorsteuer: "1576", verbindlichkeiten: "1600" },
  SKR04: { internet: "6810", telefon: "6805", buero: "6815", entnahme: "2100", vorsteuer: "1406", verbindlichkeiten: "3300" },
} as const;

describe.skipIf(!testDatabaseUrl)("Belege aus Positionen (Postgres, #1975)", () => {
  let documents: typeof import("./documents.ts");
  let eingabe: typeof import("./beleg-eingabe.ts");
  let duplizieren: typeof import("./duplizieren.ts");
  let stammdaten: typeof import("../stammdaten/index.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  let fileSeq = 0;

  beforeAll(async () => {
    sql = await setupTestDb();
    documents = await import("./documents.ts");
    eingabe = await import("./beleg-eingabe.ts");
    duplizieren = await import("./duplizieren.ts");
    stammdaten = await import("../stammdaten/index.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function reset(kontenrahmen: "SKR03" | "SKR04", versteuerung: "ist" | "soll") {
    await leeren(sql)`truncate document_cancellations, vat_returns, write_offs, allocations, cash_entries, asset_depreciations, assets,
      journal_lines, journal_entries, document_splits, document_amounts, documents, exchange_rates, year_closings, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, versteuerung, kontenrahmen, kleinunternehmer)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'BY', ${versteuerung}, ${kontenrahmen}, false)`;
  }

  async function beleg(felder: Record<string, unknown>): Promise<string> {
    fileSeq++;
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, fileSeq % 256, Math.floor(fileSeq / 256), 41]);
    const { id } = await documents.uploadDocument(actor, { bytes, filename: `pos-${fileSeq}.jpg` });
    await documents.updateDocument(actor, id, {
      supplierName: "Telekom Deutschland GmbH",
      supplierUstId: "",
      invoiceNumber: `TK-${fileSeq}`,
      documentDate: "2026-09-15",
      dueDate: null,
      payment: "bank",
      note: "",
      amounts: [],
      ...felder,
    } as never);
    return id;
  }

  const positionen = async (id: string) =>
    (await documents.getDocument(id))!.positionen.map(({ category, taxRate, net, tax, description, originalNet }) => ({
      category,
      taxRate,
      net,
      tax,
      description,
      originalNet,
    }));

  const salden = async (id: string) =>
    Object.fromEntries(
      (
        await sql<{ account: string; saldo: number }[]>`select l.account, sum(l.debit - l.credit)::int as saldo
          from journal_lines l join journal_entries e on e.id = l.entry_id
         where e.source_type = 'document' and e.source_id = ${id} group by l.account order by l.account`
      ).map((r) => [r.account, r.saldo]),
    );

  for (const [kontenrahmen, versteuerung] of [
    ["SKR03", "ist"],
    ["SKR04", "soll"],
  ] as const) {
    it(`${kontenrahmen}, ${versteuerung}: Positionen mit Entnahme und korrigierter Steuer je Satz buchen das Telefon-Beispiel`, async () => {
      await reset(kontenrahmen, versteuerung);
      const k = KONTEN[kontenrahmen];
      const id = await beleg({
        positions: [
          { category: "internet", taxRate: 1900, net: 2_520, description: "Internet" },
          { category: "privatentnahme", taxRate: 1900, net: 840, description: "25 % von Internet" },
          { category: "telefon", taxRate: 1900, net: 512, description: "Telefon" },
          { category: "privatentnahme", taxRate: 1900, net: 341, description: "40 % von Telefon" },
        ],
        // 19 % von 42,13 € sind gerundet 8,00 €; die Rechnung weist 8,01 € aus, und gebucht wird dieser Wert
        amounts: [{ taxRate: 1900, net: 0, tax: 801 }],
      });
      const geladen = (await documents.getDocument(id))!;
      expect(geladen.amounts.map(({ taxRate, net, tax }) => ({ taxRate, net, tax }))).toEqual([{ taxRate: 1900, net: 4_213, tax: 801 }]);
      expect(geladen.document).toMatchObject({ category: null, ownAccountId: null, privateShare: 0, gross: 5_014 });
      // Das bisherige Formular sieht die Positionen als Aufteilung, mit Beschreibung
      expect(eingabe.formularansicht(geladen.document, geladen.positionen).splits.map((p) => p.description)).toEqual([
        "Internet",
        "25 % von Internet",
        "Telefon",
        "40 % von Telefon",
      ]);
      await documents.bookDocument(actor, id);
      expect(await salden(id)).toEqual({
        [k.internet]: 2_520,
        [k.telefon]: 512,
        [k.vorsteuer]: 576,
        [k.entnahme]: 1_406,
        [k.verbindlichkeiten]: -5_014,
      });
    });
  }

  it("speichert Kategorie und Privatanteil des bisherigen Formulars als Positionen und zeigt sie dort wie vorher", async () => {
    await reset("SKR03", "soll");
    const id = await beleg({
      category: "telefon",
      privateShare: 40,
      amounts: [
        { taxRate: 1900, net: 853, tax: 162 },
        { taxRate: 700, net: 1_999, tax: 140 },
      ],
    });
    expect(await positionen(id)).toEqual([
      { category: "telefon", taxRate: 1900, net: 512, tax: 97, description: "", originalNet: null },
      { category: "privatentnahme", taxRate: 1900, net: 341, tax: 65, description: "", originalNet: null },
      { category: "telefon", taxRate: 700, net: 1_199, tax: 84, description: "", originalNet: null },
      { category: "privatentnahme", taxRate: 700, net: 800, tax: 56, description: "", originalNet: null },
    ]);
    const geladen = (await documents.getDocument(id))!;
    expect(geladen.document).toMatchObject({ category: null, privateShare: 0 });
    expect(eingabe.formularansicht(geladen.document, geladen.positionen)).toMatchObject({
      document: { category: "telefon", ownAccountId: null, privateShare: 40 },
      splits: [],
    });
    // Liste und REST-API nennen die eine Kategorie; als „aufgeteilt“ gilt der Beleg nicht
    const [zeile] = (await documents.listDocuments()).filter((d) => d.id === id);
    expect(zeile).toMatchObject({ category: "telefon", splitCount: 0, ownAccount: null });
  });

  it("nimmt bei kleinen Beträgen den Privatanteil der Firmendaten, wenn mehrere passen", async () => {
    await reset("SKR03", "soll");
    // 24 % und 25 % von 0,10 € ergeben dieselben Positionen
    const id = await beleg({ category: "telefon", privateShare: 25, amounts: [{ taxRate: 1900, net: 10, tax: 2 }] });
    const geladen = (await documents.getDocument(id))!;
    const vorgabe = (category: string | null) => (category === "telefon" ? 25 : undefined);
    expect(eingabe.formularansicht(geladen.document, geladen.positionen, vorgabe).document.privateShare).toBe(25);
  });

  it("lehnt einen Privatanteil neben einer Aufteilung beim Speichern ab", async () => {
    await reset("SKR03", "soll");
    await expect(
      beleg({
        privateShare: 20,
        amounts: [{ taxRate: 1900, net: 3_000, tax: 570 }],
        splits: [
          { category: "telefon", taxRate: 1900, net: 1_000 },
          { category: "internet", taxRate: 1900, net: 2_000 },
        ],
      }),
    ).rejects.toThrow(/Privatanteil mit Aufteilung/);
    await expect(beleg({ category: "telefon", positions: [{ category: "telefon", taxRate: 1900, net: 1_000 }], amounts: [] })).rejects.toThrow(
      /Mit Positionen stehen Kategorie/,
    );
  });

  it("Zeilen einer Kategorie über zwei Sätze sind ein Beleg mit einer Kategorie, auch beim Erwerb", async () => {
    await reset("SKR04", "ist");
    const id = await beleg({
      supplierUstId: "NL123456789B01",
      reverseCharge: "ig_erwerb",
      splits: [
        { category: "buero", taxRate: 1900, net: 10_000 },
        { category: "buero", taxRate: 700, net: 5_000 },
      ],
      amounts: [
        { taxRate: 1900, net: 10_000, tax: 1_900 },
        { taxRate: 700, net: 5_000, tax: 350 },
      ],
    });
    const geladen = (await documents.getDocument(id))!;
    expect(eingabe.formularansicht(geladen.document, geladen.positionen)).toMatchObject({ document: { category: "buero" }, splits: [] });
    await documents.bookDocument(actor, id);
    const s = await salden(id);
    expect(s[KONTEN.SKR04.buero]).toBe(15_000);
    expect(s[KONTEN.SKR04.verbindlichkeiten]).toBe(-15_000);
  });

  it("Fremdwährung ohne Kurs: der Privatanteil bleibt im Netto laut Beleg und folgt dem Kurs, wenn er erscheint", async () => {
    await reset("SKR03", "soll");
    const id = await beleg({
      category: "software",
      privateShare: 20,
      currency: "USD",
      exchangeRate: null,
      amounts: [{ taxRate: 0, net: 0, tax: 0, originalNet: 9_999, originalTax: 0 }],
    });
    expect(await positionen(id)).toEqual([
      { category: "software", taxRate: 0, net: 0, tax: 0, description: "", originalNet: 7_999 },
      { category: "privatentnahme", taxRate: 0, net: 0, tax: 0, description: "", originalNet: 2_000 },
    ]);
    const ohneKurs = (await documents.getDocument(id))!;
    expect(eingabe.formularansicht(ohneKurs.document, ohneKurs.positionen).document).toMatchObject({ category: "software", privateShare: 20 });
    await stammdaten.storeExchangeRates(actor, [{ currency: "USD", month: "2026-09", rate: "1.0812" }], "bmf");
    expect(await documents.applyPublishedRates(actor)).toBe(1);
    // 99,99 USD sind 92,48 €; 20 % davon wie beim Prozentsatz am Beleg gerundet
    expect(await positionen(id)).toEqual([
      { category: "software", taxRate: 0, net: 7_398, tax: 0, description: "", originalNet: 7_999 },
      { category: "privatentnahme", taxRate: 0, net: 1_850, tax: 0, description: "", originalNet: 2_000 },
    ]);
  });

  it("Fremdwährung mit Aufteilung aus dem bisherigen Formular: die Positionen bleiben, auch mit dem Kurs", async () => {
    await reset("SKR03", "soll");
    // Das bisherige Formular behält eine Aufteilung, wenn die Währung danach umgestellt wird; ihre Zeilen haben kein
    // Netto laut Beleg
    const id = await beleg({
      currency: "USD",
      exchangeRate: null,
      amounts: [{ taxRate: 1900, net: 0, tax: 0, originalNet: 10_000, originalTax: 1_900 }],
      splits: [
        { category: "telefon", taxRate: 1900, net: 7_500 },
        { category: "privatentnahme", taxRate: 1900, net: 2_500 },
      ],
    });
    const geladen = (await documents.getDocument(id))!;
    // Ohne Netto laut Beleg ergibt keine Prozentzahl diese Positionen: Das Formular zeigt sie als Aufteilung wie vorher
    const ansicht = eingabe.formularansicht(geladen.document, geladen.positionen);
    expect(ansicht.document.privateShare).toBe(0);
    expect(ansicht.splits.map((p) => p.category)).toEqual(["telefon", "privatentnahme"]);
    // Mit dem Kurs folgen die Positionen dem Euro-Netto im Verhältnis ihrer Beträge, statt zu einem Privatanteil zu werden
    await stammdaten.storeExchangeRates(actor, [{ currency: "USD", month: "2026-09", rate: "1.25" }], "bmf");
    expect(await documents.applyPublishedRates(actor)).toBe(1);
    expect((await positionen(id)).map(({ category, net }) => ({ category, net }))).toEqual([
      { category: "telefon", net: 6_000 },
      { category: "privatentnahme", net: 2_000 },
    ]);
  });

  it("ein Entwurf ohne Kategorie hat Positionen ohne Kategorie und lässt sich erst mit einer buchen", async () => {
    await reset("SKR03", "soll");
    const id = await beleg({ category: null, amounts: [{ taxRate: 1900, net: 1_000, tax: 190 }] });
    expect(await positionen(id)).toEqual([{ category: null, taxRate: 1900, net: 1_000, tax: 190, description: "", originalNet: null }]);
    const geladen = (await documents.getDocument(id))!;
    expect(documents.bookingIssues(geladen.document, geladen.amounts, "2026-09-20", geladen.positionen)).toContain("Kategorie fehlt");
    expect(eingabe.formularansicht(geladen.document, geladen.positionen)).toMatchObject({ document: { category: null }, splits: [] });
    const [zeile] = (await documents.listDocuments()).filter((d) => d.id === id);
    expect(zeile).toMatchObject({ category: null, splitCount: 0 });
  });

  it("Duplizieren übernimmt Kategorie und Privatanteil mit derselben Rundung", async () => {
    await reset("SKR03", "soll");
    const id = await beleg({ category: "telefon", privateShare: 25, amounts: [{ taxRate: 1900, net: 1_001, tax: 190 }] });
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 7, 7, 7]);
    const kopie = await duplizieren.duplicateDocument(actor, id, { bytes, filename: "kopie.jpg" });
    expect(await positionen(kopie.id)).toEqual(await positionen(id));
  });
});
