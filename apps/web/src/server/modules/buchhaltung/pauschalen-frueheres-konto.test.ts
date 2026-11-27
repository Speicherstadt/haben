import { ACCOUNTS, bwaZeitraum, type Kontenrahmen } from "@haben/core";
import { parseDatevBuchungsstapel } from "@haben/import";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Homeoffice-Pauschale auf dem Konto der Tagespauschale (#2015): Bis dahin buchte Haben sie auf das Konto des häuslichen
 * Arbeitszimmers (SKR03 4288, SKR04 6348). Diese Buchungen bleiben festgeschrieben, wie sie sind, zählen in EÜR und BWA
 * weiter als Tagespauschale, und ein Storno bucht auf ihr Konto zurück. Die alten Buchungen legt der Test so an, wie
 * Haben sie vorher gebucht hat.
 */
describe.skipIf(!testDatabaseUrl)("Homeoffice-Pauschale auf dem früheren Konto (Postgres)", () => {
  let pauschalen: typeof import("./pauschalen.ts");
  let ledger: typeof import("./ledger.ts");
  let actorDb: typeof import("../../db/actor.ts");
  let dbIndex: typeof import("../../db/index.ts");
  let reports: typeof import("../auswertungen/reports.ts");
  let abgleich: typeof import("../auswertungen/abgleich.ts");
  let bwa: typeof import("../auswertungen/bwa.ts");
  let datev: typeof import("../auswertungen/datev-export.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  const today = "2026-10-03";
  const FRUEHER: Record<Kontenrahmen, string> = { SKR03: "4288", SKR04: "6348" };
  const NEU: Record<Kontenrahmen, string> = { SKR03: "4287", SKR04: "6347" };

  beforeAll(async () => {
    sql = await setupTestDb();
    pauschalen = await import("./pauschalen.ts");
    ledger = await import("./ledger.ts");
    actorDb = await import("../../db/actor.ts");
    dbIndex = await import("../../db/index.ts");
    reports = await import("../auswertungen/reports.ts");
    abgleich = await import("../auswertungen/abgleich.ts");
    bwa = await import("../auswertungen/bwa.ts");
    datev = await import("../auswertungen/datev-export.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function reset(kontenrahmen: Kontenrahmen, versteuerung: "ist" | "soll") {
    await leeren(sql)`truncate pauschalen, journal_lines, journal_entries, company cascade`;
    await sql`insert into company (id, name, versteuerung, kontenrahmen, bundesland) values (1, 'Testfirma', ${versteuerung}, ${kontenrahmen}, 'BW')`;
  }

  /** Eine Homeoffice-Pauschale, wie Haben sie vor #2015 gebucht hat: Arbeitszimmer an Privateinlage */
  async function altePauschale(kontenrahmen: Kontenrahmen, date: string, tage: number): Promise<string> {
    return actorDb.withActor(actor, async (tx) => {
      const books = await ledger.openBooks(tx);
      const id = crypto.randomUUID();
      const amount = tage * 600;
      const journalEntryId = await ledger.post(tx, books, {
        date,
        description: `Homeoffice: ${tage} Tage`,
        sourceType: "pauschale",
        sourceId: id,
        lines: [
          { account: FRUEHER[kontenrahmen], debit: amount, credit: 0, taxCode: null },
          { account: ACCOUNTS[kontenrahmen].privateinlagen, debit: 0, credit: amount, taxCode: null },
        ],
      });
      await tx.insert(dbIndex.schema.pauschalen).values({ id, art: "homeoffice", date, description: "", details: { tage }, amount, journalEntryId });
      return id;
    });
  }

  const zeilenDer = async (journalEntryId: string) =>
    (await sql`select account, debit, credit from journal_lines where entry_id = ${journalEntryId} order by debit desc`).map((r) => ({ ...r }));

  const saldo = async (account: string) =>
    Number((await sql`select coalesce(sum(debit - credit), 0)::int as saldo from journal_lines where account = ${account}`)[0]!.saldo);

  for (const [kontenrahmen, versteuerung] of [
    ["SKR03", "ist"],
    ["SKR04", "soll"],
  ] as const) {
    it(`alte und neue Pauschale im selben Jahr, Storno der alten auf ihr Konto, EÜR und BWA (${kontenrahmen}, ${versteuerung})`, async () => {
      await reset(kontenrahmen, versteuerung);
      const einlage = ACCOUNTS[kontenrahmen].privateinlagen;
      await altePauschale(kontenrahmen, "2026-03-31", 10);
      const storniert = await altePauschale(kontenrahmen, "2026-04-30", 5);
      const neu = await pauschalen.createPauschale(actor, { art: "homeoffice", month: "2026-05", tage: 12 }, today);

      // Neue Pauschalen auf das Konto der Tagespauschale
      expect(await zeilenDer(neu.journalEntryId)).toEqual([
        { account: NEU[kontenrahmen], debit: 7_200, credit: 0 },
        { account: einlage, debit: 0, credit: 7_200 },
      ]);
      // Das Storno einer alten bucht auf deren Konto zurück, sonst blieben auf beiden Konten Salden stehen
      await pauschalen.reversePauschale(actor, storniert);
      const [storno] = await sql`select journal_entry_id from pauschalen where reverses_id = ${storniert}`;
      expect(await zeilenDer(storno!.journal_entry_id)).toEqual([
        { account: einlage, debit: 3_000, credit: 0 },
        { account: FRUEHER[kontenrahmen], debit: 0, credit: 3_000 },
      ]);
      expect([await saldo(FRUEHER[kontenrahmen]), await saldo(NEU[kontenrahmen])]).toEqual([6_000, 7_200]);

      // EÜR aus dem Journal: alte und neue zusammen in der Zeile der Tagespauschale, ohne Abweichung
      const euer = await reports.euerForYear(2026);
      const zeilen = Object.fromEntries([...euer.einnahmen, ...euer.ausgaben].filter((l) => l.amount !== 0).map((l) => [l.key, l.amount]));
      expect(zeilen).toEqual({ "pauschale:homeoffice": 13_200 });
      expect(euer.gewinn).toBe(-13_200);
      const pruefung = await abgleich.euerAbgleich(2026);
      expect(pruefung.hinweise).toEqual([]);
      expect(abgleich.abweichungen(pruefung.zeilen)).toEqual([]);
      expect((await pauschalen.listPauschalen(2026)).homeoffice.tage).toBe(22);

      // BWA: beide bei den Raumkosten, Ergebnis gleich dem Gewinn der EÜR
      const bericht = await bwa.bwaBericht(bwaZeitraum("jahr", 2026), "keiner");
      const zeile = (key: string) => bericht.zeilen.find((z) => z.key === key)!.betrag;
      expect([zeile("raum"), zeile("gewinnEuer")]).toEqual([13_200, -13_200]);
    });
  }

  it("DATEV-Export: jede Pauschale mit dem Konto, auf dem sie im Journal steht", async () => {
    await reset("SKR03", "ist");
    await altePauschale("SKR03", "2026-03-31", 10);
    await pauschalen.createPauschale(actor, { art: "homeoffice", month: "2026-05", tage: 12 }, today);
    await datev.saveDatevNumbers(actor, { beraterNr: "29098", mandantNr: "55003" });
    const stack = parseDatevBuchungsstapel((await datev.datevExport(2026, new Date(2026, 9, 4, 8, 0, 0))).bytes);
    expect(stack.bookings.map((b) => [b.account, b.contraAccount, b.amount].join("/")).sort()).toEqual(["4287/1890/7200", "4288/1890/6000"]);
  });
});
