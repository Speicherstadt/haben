import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Entnahme einer Anlage (#1970): Umsatzsteuer im Monat der Entnahme aus dem Anlagenverzeichnis (§ 3 Abs. 1b, § 13 Abs. 1
 * Nr. 2 UStG, bei Ist und Soll gleich), Zeile 19 der EÜR, Buchung mit der AfA des Jahres und Abgleich gegen das
 * Verzeichnis. SKR03 und SKR04, Ist und Soll, regelbesteuert und Kleinunternehmer, mit und ohne Vorsteuer beim Kauf.
 */
describe.skipIf(!testDatabaseUrl)("Entnahme einer Anlage (Postgres)", () => {
  let assets: typeof import("./assets.ts");
  let reports: typeof import("../auswertungen/reports.ts");
  let abgleich: typeof import("../auswertungen/abgleich.ts");
  let figures: typeof import("../umsatzsteuer/vat-figures.ts");
  let annual: typeof import("../jahreserklaerung/annual.ts");
  let sql: postgres.Sql;
  const actor = "entnahme-test";

  beforeAll(async () => {
    sql = await setupTestDb();
    assets = await import("./assets.ts");
    reports = await import("../auswertungen/reports.ts");
    abgleich = await import("../auswertungen/abgleich.ts");
    figures = await import("../umsatzsteuer/vat-figures.ts");
    annual = await import("../jahreserklaerung/annual.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function firma(kontenrahmen: "SKR03" | "SKR04", versteuerung: "ist" | "soll", kleinunternehmer = false, rechtsform = "einzelunternehmen") {
    await sql`insert into company (id, name, versteuerung, kontenrahmen, bundesland, kleinunternehmer, rechtsform)
      values (1, 'Testfirma', ${versteuerung}, ${kontenrahmen}, 'BY', ${kleinunternehmer}, ${rechtsform})`;
  }

  beforeEach(async () => {
    await leeren(sql)`truncate asset_depreciations, assets, allocations, bank_transactions, bank_imports, bank_accounts,
      journal_lines, journal_entries, document_amounts, documents, company cascade`;
  });

  // Kamera, linear über 4 Jahre ab Januar 2024, zum 01.01.2026 übernommen: 24 Restmonate zu 50 €
  const kamera = {
    name: "Kamera",
    kind: "sonstiges" as const,
    method: "linear" as const,
    acquisitionDate: "2024-01-10",
    cost: 240_000,
    usefulLifeMonths: 48,
    openingDate: "2026-01-01",
    openingBookValue: 120_000,
    disposalDate: null,
    note: "",
  };

  const linesOf = async (sourceId: string, from: string) =>
    (
      await sql`select e.date::text as date, l.account, l.debit, l.credit, l.tax_code as "taxCode" from journal_lines l
      join journal_entries e on e.id = l.entry_id where e.source_id = ${sourceId} and e.date >= ${from}
      order by e.date, e.description, l.debit desc, l.credit desc`
    ).map((r) => ({ ...r }));

  const zeile = (euer: { einnahmen: { key: string; amount: number }[]; ausgaben: { key: string; amount: number }[] }, key: string) =>
    [...euer.einnahmen, ...euer.ausgaben].find((l) => l.key === key)?.amount ?? 0;

  it("SKR03, Ist, regelbesteuert mit Vorsteuer: Kz 81 im Monat der Entnahme, Zeile 19, Buchgewinn auf 8820 und 2315, Abgleich", async () => {
    await firma("SKR03", "ist");
    const asset = await assets.createAsset(actor, kamera);
    await assets.bookDepreciation(actor, 2026, "2026-12-05");
    // 2026 ist gebucht: Eine Entnahme in diesem Jahr geht nicht mehr, im Folgejahr schon
    await expect(
      assets.updateAsset(actor, asset.id, { name: "Kamera", disposalDate: "2026-11-30", disposalWithdrawal: { value: 80_000, inputVat: true } }),
    ).rejects.toThrow("schon gebucht");
    await assets.updateAsset(actor, asset.id, { name: "Kamera", disposalDate: "2027-03-20", disposalWithdrawal: { value: 80_000, inputVat: true } });

    const maerz = await figures.computeVatFigures({ year: 2027, month: 3 });
    expect(maerz).toMatchObject({ kz81: 80_000, tax81: 15_200 });
    expect(maerz.revenue.filter((r) => r.type === "entnahme")).toEqual([expect.objectContaining({ assetId: asset.id, base: 80_000, tax: 15_200 })]);
    expect((await figures.computeVatFigures({ year: 2027, month: 2 })).kz81).toBe(0);

    // Vor dem Buchen aus dem Anlagenverzeichnis: AfA Januar bis März 150 €, Restbuchwert 450 €
    let euer = await reports.euerForYear(2027);
    expect([zeile(euer, "anlagenabgang"), zeile(euer, "ustEntnahmen"), zeile(euer, "afa"), zeile(euer, "restbuchwert")]).toEqual([
      80_000, 15_200, 15_000, 45_000,
    ]);

    await assets.bookDepreciation(actor, 2027, "2028-01-10");
    expect(await linesOf(asset.id, "2027-01-01")).toEqual([
      { date: "2027-03-20", account: "2315", debit: 45_000, credit: 0, taxCode: null },
      { date: "2027-03-20", account: "4830", debit: 15_000, credit: 0, taxCode: null },
      { date: "2027-03-20", account: "0490", debit: 0, credit: 45_000, taxCode: null },
      { date: "2027-03-20", account: "0490", debit: 0, credit: 15_000, taxCode: null },
      { date: "2027-03-20", account: "1800", debit: 95_200, credit: 0, taxCode: null },
      { date: "2027-03-20", account: "8820", debit: 0, credit: 80_000, taxCode: "USt19" },
      { date: "2027-03-20", account: "1776", debit: 0, credit: 15_200, taxCode: "USt19" },
    ]);
    // Gebucht: dieselben Zahlen aus dem Journal, die Voranmeldung zählt die Buchung nicht doppelt
    euer = await reports.euerForYear(2027);
    expect([zeile(euer, "anlagenabgang"), zeile(euer, "ustEntnahmen"), zeile(euer, "restbuchwert")]).toEqual([80_000, 15_200, 45_000]);
    expect((await figures.computeVatFigures({ year: 2027, month: 3 })).kz81).toBe(80_000);
    const { zeilen } = await abgleich.euerAbgleich(2027);
    expect(abgleich.abweichungen(zeilen)).toEqual([]);
    expect(zeilen.find((z) => z.posten === "Entnahme von Anlagen")).toMatchObject({ journal: 80_000, quelle: 80_000 });
    expect((await annual.euerYear(2027)).figures).toMatchObject({ anlagenabgang: 80_000 });

    // Gebucht: Art und Werte des Abgangs sind fest, auch in der Datenbank
    await expect(
      assets.updateAsset(actor, asset.id, { name: "Kamera", disposalDate: "2027-03-20", disposalWithdrawal: { value: 90_000, inputVat: true } }),
    ).rejects.toThrow("schon gebucht");
    await expect(sql`update assets set disposal_withdrawal = '{"value": 1, "inputVat": false}'::jsonb where id = ${asset.id}`).rejects.toThrow(
      "Abgang",
    );
    await expect(sql`update assets set disposal_date = '2027-04-30' where id = ${asset.id}`).rejects.toThrow("Abgang");
    await sql`update assets set note = 'privat' where id = ${asset.id}`;
  });

  it("SKR04, Soll, Kleinunternehmer mit Vorsteuer: Kz 48, keine Umsatzsteuer, Buchverlust auf 6889 und 6895", async () => {
    await firma("SKR04", "soll", true);
    const asset = await assets.createAsset(actor, { ...kamera, disposalDate: "2026-10-15", disposalWithdrawal: { value: 30_000, inputVat: true } });

    const oktober = await figures.computeVatFigures({ year: 2026, month: 10 });
    expect(oktober).toMatchObject({ kz81: 0, tax81: 0, kz48: 30_000, kz48Kleinunternehmer: 30_000 });
    // Umsätze von Anlagevermögen bleiben im Gesamtumsatz außer Ansatz, auch bei einer Entnahme (UStAE 19.2 Abs. 4)
    const { gesamtumsatzForYear } = await import("../auswertungen/gesamtumsatz.ts");
    expect((await gesamtumsatzForYear(2026)).items).toEqual([]);

    await assets.bookDepreciation(actor, 2026, "2026-12-05");
    // AfA Januar bis Oktober 500 €, Restbuchwert 700 € über dem Entnahmewert
    expect((await linesOf(asset.id, "2026-10-01")).map((l) => [l.account, l.debit, l.credit])).toEqual([
      ["6895", 70_000, 0],
      ["6220", 50_000, 0],
      ["0690", 0, 70_000],
      ["0690", 0, 50_000],
      ["2100", 30_000, 0],
      ["6889", 0, 30_000],
    ]);
    const euer = await reports.euerForYear(2026);
    expect([zeile(euer, "anlagenabgang"), zeile(euer, "ustEntnahmen"), zeile(euer, "restbuchwert")]).toEqual([30_000, 0, 70_000]);
    expect(abgleich.abweichungen((await abgleich.euerAbgleich(2026)).zeilen)).toEqual([]);
  });

  it("ohne Vorsteuer beim Kauf: keine Kennzahl, der Entnahmewert steht trotzdem in Zeile 19", async () => {
    await firma("SKR03", "soll");
    await assets.createAsset(actor, { ...kamera, disposalDate: "2026-10-15", disposalWithdrawal: { value: 80_000, inputVat: false } });
    const oktober = await figures.computeVatFigures({ year: 2026, month: 10 });
    expect(oktober).toMatchObject({ kz81: 0, kz48: 0 });
    expect(oktober.revenue.filter((r) => r.type === "entnahme")).toEqual([]);
    const euer = await reports.euerForYear(2026);
    expect([zeile(euer, "anlagenabgang"), zeile(euer, "ustEntnahmen")]).toEqual([80_000, 0]);
  });

  it("Entnahme nur mit Abgangsdatum und nur im Einzelunternehmen", async () => {
    await firma("SKR03", "ist");
    await expect(assets.createAsset(actor, { ...kamera, disposalWithdrawal: { value: 80_000, inputVat: true } })).rejects.toThrow("Abgangsdatum");
    const asset = await assets.createAsset(actor, { ...kamera, disposalDate: "2026-10-15", disposalWithdrawal: { value: 80_000, inputVat: true } });
    // Ohne Abgang fällt die Entnahme mit weg
    const ohne = await assets.updateAsset(actor, asset.id, { name: "Kamera", disposalDate: null });
    expect(ohne.disposalWithdrawal).toBeNull();
    await sql`update company set rechtsform = 'gmbh'`;
    await expect(
      assets.updateAsset(actor, asset.id, { name: "Kamera", disposalDate: "2026-10-15", disposalWithdrawal: { value: 80_000, inputVat: true } }),
    ).rejects.toThrow("nur im Einzelunternehmen");
  });
});
