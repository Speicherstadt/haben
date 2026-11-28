import { bwaZeitraum, form43Zeile, type Kontenrahmen } from "@haben/core";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Review zu #2043 (Konten nach dem Buchungsjahr, docs/adr/kontenrahmen-ausgaben.md): Eine für 2024 nachgetragene
 * Homeoffice-Pauschale steht auf dem Konto von 2024 (SKR03 4288, SKR04 6348). Der Drilldown der BWA nennt in der
 * Überschrift der Gruppe aber das heutige Konto (4287 bzw. 6347, euerZeilenKonto) und verlinkt dessen Kontenblatt im Jahr;
 * dort steht die Buchung nicht.
 */
describe.skipIf(!testDatabaseUrl)("Review #2043: BWA-Drilldown einer Pauschale auf dem Konto ihres Buchungsjahres (Postgres)", () => {
  let pauschalen: typeof import("./pauschalen.ts");
  let buchhaltung: typeof import("./index.ts");
  let actorDb: typeof import("../../db/actor.ts");
  let dbIndex: typeof import("../../db/index.ts");
  let bwa: typeof import("../auswertungen/bwa.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  const today = "2026-11-28";
  const HOMEOFFICE = { SKR03: { bis2024: "4288", ab2025: "4287" }, SKR04: { bis2024: "6348", ab2025: "6347" } } as const;

  beforeAll(async () => {
    sql = await setupTestDb();
    pauschalen = await import("./pauschalen.ts");
    buchhaltung = await import("./index.ts");
    actorDb = await import("../../db/actor.ts");
    dbIndex = await import("../../db/index.ts");
    bwa = await import("../auswertungen/bwa.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function reset(kontenrahmen: Kontenrahmen, versteuerung: "ist" | "soll") {
    await leeren(sql)`truncate seals, audit_log, pauschalen, journal_lines, journal_entries, year_closings, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, kontenrahmen, versteuerung)
      values (1, 'Musterbetrieb', 'Beispielstraße 1', '93047', 'Regensburg', 'firma@example.com', '198/113/10010', 'BY', ${kontenrahmen}, ${versteuerung})`;
  }

  for (const [kontenrahmen, versteuerung] of [
    ["SKR03", "ist"],
    ["SKR04", "soll"],
  ] as const) {
    for (const [monat, jahr, stichtag, konto] of [
      ["2024-11", 2024, "2024-11-30", HOMEOFFICE[kontenrahmen].bis2024],
      ["2025-03", 2025, "2025-03-31", HOMEOFFICE[kontenrahmen].ab2025],
    ] as const) {
      it(`Homeoffice-Pauschale für ${jahr}: Die Gruppe nennt das Konto, in dessen Kontenblatt die Buchung steht (${kontenrahmen}, ${versteuerung})`, async () => {
        await reset(kontenrahmen, versteuerung);
        const pauschale = await pauschalen.createPauschale(actor, { art: "homeoffice", month: monat, tage: 10 }, today);
        const [zeile] = await sql<{ account: string }[]>`select account from journal_lines where entry_id = ${pauschale.journalEntryId} and debit > 0`;
        expect(zeile!.account).toBe(konto);

        const gruppen = await bwa.bwaZeileDetails(bwaZeitraum("jahr", jahr), form43Zeile(kontenrahmen, "pauschale:homeoffice"));
        const gruppe = gruppen.find((g) => g.euerZeile === "pauschale:homeoffice");
        expect(gruppe?.betrag).toBe(6_000);
        // Die Zeile selbst verlinkt das Konto ihrer Buchung
        expect(gruppe!.vorgaenge.map((v) => v.konto)).toEqual([konto]);
        // Die Seite verlinkt von der Überschrift der Gruppe ins Kontenblatt von `konto` im Jahr (auswertungen_.bwa.tsx,
        // ZeileDetails): Dort muss die Buchung stehen
        const blatt = await buchhaltung.kontenblatt(gruppe!.konto!, buchhaltung.ledgerRange(jahr));
        expect(
          blatt.zeilen.filter((z) => z.entryId === pauschale.journalEntryId).map((z) => [z.date, z.soll]),
          `Kontenblatt ${gruppe!.konto} für ${jahr}`,
        ).toEqual([[stichtag, 6_000]]);
        expect(gruppe!.konto).toBe(konto);
      }, 60_000);
    }
  }

  it("Bestand auf dem früheren Konto: allein nennt die Gruppe dieses Konto, neben neuen Pauschalen das heutige", async () => {
    await reset("SKR03", "ist");
    // Eine Homeoffice-Pauschale für 2026, wie Haben sie vor #2015 gebucht hat: auf dem Konto des Arbeitszimmers
    await actorDb.withActor(actor, async (tx) => {
      const id = crypto.randomUUID();
      const journalEntryId = await buchhaltung.post(tx, await buchhaltung.openBooks(tx), {
        date: "2026-03-31",
        description: "Homeoffice März: 10 Tage",
        sourceType: "pauschale",
        sourceId: id,
        lines: [
          { account: "4288", debit: 6_000, credit: 0, taxCode: null },
          { account: "1890", debit: 0, credit: 6_000, taxCode: null },
        ],
      });
      await tx
        .insert(dbIndex.schema.pauschalen)
        .values({ id, art: "homeoffice", date: "2026-03-31", description: "", details: { tage: 10 }, amount: 6_000, journalEntryId });
    });
    const gruppe = async () =>
      (await bwa.bwaZeileDetails(bwaZeitraum("jahr", 2026), form43Zeile("SKR03", "pauschale:homeoffice"))).find((g) => g.euerZeile === "pauschale:homeoffice")!;
    expect([(await gruppe()).konto, (await gruppe()).vorgaenge.map((v) => v.konto)]).toEqual(["4288", ["4288"]]);

    await pauschalen.createPauschale(actor, { art: "homeoffice", month: "2026-05", tage: 12 }, today);
    // Zwei Konten in einem Jahr: Die Überschrift nennt das heutige, jede Zeile verlinkt ihr eigenes
    expect([(await gruppe()).konto, (await gruppe()).vorgaenge.map((v) => v.konto)]).toEqual(["4287", ["4288", "4287"]]);
  }, 60_000);
});
