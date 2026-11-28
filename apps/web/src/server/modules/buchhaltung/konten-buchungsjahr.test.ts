import { ACCOUNTS, type Kontenrahmen } from "@haben/core";
import { parseDatevBuchungsstapel } from "@haben/import";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Konten nach dem Buchungsjahr (#2043, docs/adr/kontenrahmen-ausgaben.md): DATEV gibt SKR03 und SKR04 je Jahr heraus. Die
 * Tagespauschale (4287 bzw. 6347) und die steuerfreien Kleinunternehmererlöse (8192 bzw. 4184) gibt es „ab dem Jahr 2025“
 * (Programmänderungen Kanzlei-Rechnungswesen 13.3). Ein Nachtrag für 2024 steht deshalb auf dem Konto, das 2024 galt, und
 * der DATEV-Stapel für 2024 trägt kein Konto, das es dort nicht gab.
 */
describe.skipIf(!testDatabaseUrl)("Konten nach dem Buchungsjahr (Postgres)", () => {
  let pauschalen: typeof import("./pauschalen.ts");
  let ledger: typeof import("./ledger.ts");
  let actorDb: typeof import("../../db/actor.ts");
  let bank: typeof import("../bank/index.ts");
  let reports: typeof import("../auswertungen/reports.ts");
  let abgleich: typeof import("../auswertungen/abgleich.ts");
  let datev: typeof import("../auswertungen/datev-export.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  const today = "2026-11-28";
  const HOMEOFFICE = { SKR03: { bis2024: "4288", ab2025: "4287" }, SKR04: { bis2024: "6348", ab2025: "6347" } } as const;
  const KLEINUNTERNEHMER = { SKR03: { bis2024: "8195", ab2025: "8192" }, SKR04: { bis2024: "4185", ab2025: "4184" } } as const;

  beforeAll(async () => {
    sql = await setupTestDb();
    pauschalen = await import("./pauschalen.ts");
    ledger = await import("./ledger.ts");
    actorDb = await import("../../db/actor.ts");
    bank = await import("../bank/index.ts");
    reports = await import("../auswertungen/reports.ts");
    abgleich = await import("../auswertungen/abgleich.ts");
    datev = await import("../auswertungen/datev-export.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function reset(kontenrahmen: Kontenrahmen, versteuerung: "ist" | "soll") {
    await leeren(sql)`truncate seals, audit_log, pauschalen, allocations, cash_entries, journal_lines, journal_entries, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, kontenrahmen, versteuerung, kleinunternehmer, datev_berater_nr, datev_mandant_nr)
      values (1, 'Musterbetrieb', 'Beispielstraße 1', '93047', 'Regensburg', 'firma@example.com', '198/113/10010', 'BY', ${kontenrahmen}, ${versteuerung}, true, '29098', '55003')`;
  }

  const zeilenDer = async (journalEntryId: string) =>
    (await sql`select account, debit, credit from journal_lines where entry_id = ${journalEntryId} order by debit desc`).map((r) => ({ ...r }));

  const zeilenZu = async (sourceId: string) =>
    (
      await sql`select l.account, l.debit, l.credit from journal_lines l join journal_entries e on e.id = l.entry_id
        where e.source_id = ${sourceId} order by l.debit desc`
    ).map((r) => ({ ...r }));

  const bareinnahme = (date: string, amount: number) =>
    bank.createCashIncome(actor, { date, amount, text: "Barverkauf", steuer: { behandlung: "kleinunternehmer", steuersatz: 0 } }, today);

  const euerZeilen = async (jahr: number) => {
    const euer = await reports.euerForYear(jahr);
    return Object.fromEntries([...euer.einnahmen, ...euer.ausgaben].filter((l) => l.amount !== 0).map((l) => [l.key, l.amount]));
  };

  for (const [kontenrahmen, versteuerung] of [
    ["SKR03", "ist"],
    ["SKR04", "soll"],
  ] as const) {
    it(`Nachtrag für 2024 auf den Konten von 2024, Buchung für 2025 auf den heutigen (${kontenrahmen}, ${versteuerung})`, async () => {
      await reset(kontenrahmen, versteuerung);
      const { privateinlagen, kasse } = ACCOUNTS[kontenrahmen];
      const homeoffice = HOMEOFFICE[kontenrahmen];
      const erloese = KLEINUNTERNEHMER[kontenrahmen];

      // Homeoffice-Pauschale: für 2024 nachgetragen und für 2025
      const nachtrag = await pauschalen.createPauschale(actor, { art: "homeoffice", month: "2024-11", tage: 10 }, today);
      const spaeter = await pauschalen.createPauschale(actor, { art: "homeoffice", month: "2025-03", tage: 12 }, today);
      expect(await zeilenDer(nachtrag.journalEntryId)).toEqual([
        { account: homeoffice.bis2024, debit: 6_000, credit: 0 },
        { account: privateinlagen, debit: 0, credit: 6_000 },
      ]);
      expect(await zeilenDer(spaeter.journalEntryId)).toEqual([
        { account: homeoffice.ab2025, debit: 7_200, credit: 0 },
        { account: privateinlagen, debit: 0, credit: 7_200 },
      ]);

      // Kleinunternehmererlöse: Bareinnahme für 2024 und für 2025
      const alt = await bareinnahme("2024-12-02", 20_000);
      const neu = await bareinnahme("2025-01-07", 30_000);
      expect(await zeilenZu(alt.id)).toEqual([
        { account: kasse, debit: 20_000, credit: 0 },
        { account: erloese.bis2024, debit: 0, credit: 20_000 },
      ]);
      expect(await zeilenZu(neu.id)).toEqual([
        { account: kasse, debit: 30_000, credit: 0 },
        { account: erloese.ab2025, debit: 0, credit: 30_000 },
      ]);

      // EÜR aus dem Journal: jedes Jahr mit seiner Pauschale und seinen Erlösen, ohne Abweichung
      expect(await euerZeilen(2024)).toEqual({ einnahmenKleinunternehmer: 20_000, "pauschale:homeoffice": 6_000 });
      expect(await euerZeilen(2025)).toEqual({ einnahmenKleinunternehmer: 30_000, "pauschale:homeoffice": 7_200 });
      for (const jahr of [2024, 2025]) {
        const pruefung = await abgleich.euerAbgleich(jahr);
        expect(pruefung.hinweise).toEqual([]);
        expect(abgleich.abweichungen(pruefung.zeilen)).toEqual([]);
      }

      // DATEV-Stapel je Jahr: 2024 ohne ein Konto, das DATEV erst ab 2025 führt
      const konten = async (jahr: number) => {
        const stapel = parseDatevBuchungsstapel((await datev.datevExport(jahr, new Date("2026-11-28T08:00:00Z"))).bytes);
        return stapel.bookings.flatMap((b) => [b.account, b.contraAccount]).sort();
      };
      expect(await konten(2024)).toEqual([kasse, privateinlagen, homeoffice.bis2024, erloese.bis2024].sort());
      expect(await konten(2025)).toEqual([kasse, privateinlagen, homeoffice.ab2025, erloese.ab2025].sort());

      // Das Storno des Nachtrags steht auf demselben Konto wie er
      await pauschalen.reversePauschale(actor, nachtrag.id);
      const [storno] = await sql`select journal_entry_id from pauschalen where reverses_id = ${nachtrag.id}`;
      expect(await zeilenDer(storno!.journal_entry_id)).toEqual([
        { account: privateinlagen, debit: 6_000, credit: 0 },
        { account: homeoffice.bis2024, debit: 0, credit: 6_000 },
      ]);
      expect(await sql`select art, tabelle, zeile, befund from haben_integrity_problems(1000)`).toEqual([]);
    });
  }

  it("Bestand bleibt: Eine Gegenbuchung spiegelt die Konten ihrer Buchung, ein selbst angegebenes Konto bleibt wie angegeben", async () => {
    await reset("SKR03", "ist");
    const { privateinlagen } = ACCOUNTS.SKR03;
    // So stand eine für 2024 nachgetragene Pauschale im Journal, solange Haben jedes Jahr nach der neuesten Ausgabe buchte.
    // Als freie Buchung angelegt: Ein Konto, das der Nutzer selbst angibt, setzt Haben nicht um.
    const bestand = await actorDb.withActor(actor, async (tx) =>
      ledger.post(tx, await ledger.openBooks(tx), {
        date: "2024-11-30",
        description: "Homeoffice November: 10 Tage",
        sourceType: "manuell",
        sourceId: crypto.randomUUID(),
        lines: [
          { account: "4287", debit: 6_000, credit: 0, taxCode: null },
          { account: privateinlagen, debit: 0, credit: 6_000, taxCode: null },
        ],
      }),
    );
    expect(await zeilenDer(bestand)).toEqual([
      { account: "4287", debit: 6_000, credit: 0 },
      { account: privateinlagen, debit: 0, credit: 6_000 },
    ]);
    // Die Gegenbuchung einer Pauschale auf 4287 in 2024 bucht auf 4287 zurück, nicht auf das Konto von 2024
    const storno = await actorDb.withActor(actor, async (tx) =>
      ledger.post(tx, await ledger.openBooks(tx), {
        date: "2024-11-30",
        description: "Storno Homeoffice November",
        sourceType: "pauschale",
        sourceId: crypto.randomUUID(),
        reversesId: bestand,
        lines: [
          { account: privateinlagen, debit: 6_000, credit: 0, taxCode: null },
          { account: "4287", debit: 0, credit: 6_000, taxCode: null },
        ],
      }),
    );
    expect(await zeilenDer(storno)).toEqual([
      { account: privateinlagen, debit: 6_000, credit: 0 },
      { account: "4287", debit: 0, credit: 6_000 },
    ]);
  });
});
