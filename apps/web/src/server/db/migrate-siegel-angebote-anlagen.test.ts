import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../test-db.ts";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const TAG = "_siegel_angebote_anlagen";

/*
 * Migration „Siegel für Angebote und Anlagen“ (#2039): Festgeschriebene Angebote und gebuchte Anlagen von vorher bekommen
 * ein Siegel mit genesis = true wie in 0064; Entwürfe und ungebuchte Anlagen keins. Danach meldet die Prüfung nichts, und
 * eine stille Änderung fällt auf.
 */
describe.skipIf(!testDatabaseUrl)("Migration: Siegel für Angebote und Anlagen im Bestand (Postgres)", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    const name = decodeURIComponent(new URL(testDatabaseUrl!).pathname.slice(1));
    const admin = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    await admin`drop database if exists ${admin(name)} with (force)`;
    await admin`create database ${admin(name)}`;
    await admin.end();
    const previous = mkdtempSync(join(tmpdir(), "haben-migrationen-"));
    cpSync(MIGRATIONS, previous, { recursive: true });
    const full = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
    const idx = full.entries.findIndex((e: { tag: string }) => e.tag.endsWith(TAG));
    expect(idx).toBeGreaterThan(0);
    writeFileSync(join(previous, "meta", "_journal.json"), JSON.stringify({ ...full, entries: full.entries.slice(0, idx) }));
    sql = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(drizzle(sql), { migrationsFolder: previous });
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function quote(locked: boolean) {
    const [q] = await sql`insert into quotes (issue_date, valid_until, net, tax, gross, pdf)
      values ('2026-01-10', '2026-02-10', 10000, 1900, 11900, ${Buffer.from("%PDF-1.7")}) returning id`;
    await sql`insert into quote_lines (quote_id, position, description, quantity, unit, unit_price, tax_rate, net)
      values (${q!.id}, 1, 'Beratung', 1000, 'h', 10000, 1900, 10000)`;
    await sql`insert into quote_attachments (quote_id, filename, mime_type, sha256, size)
      values (${q!.id}, 'plan.pdf', 'application/pdf', ${"a".repeat(64)}, 10)`;
    if (locked) await sql`update quotes set status = 'final', number = ${`AN-${q!.id.slice(0, 8)}`}, locked_at = now() where id = ${q!.id}`;
    return q!.id as string;
  }

  async function entry() {
    return sql.begin(async (tx) => {
      const [e] = await tx`insert into journal_entries (date, description, source_type, source_id, kontenrahmen)
        values ('2026-12-31', 'AfA', 'asset', gen_random_uuid(), 'SKR03') returning id`;
      await tx`insert into journal_lines (entry_id, account, debit, credit) values (${e!.id}, '4830', 50000, 0), (${e!.id}, '0650', 0, 50000)`;
      await tx`update journal_entries set locked_at = now() where id = ${e!.id}`;
      return e!.id as string;
    });
  }

  async function asset(opening = false) {
    const [a] = opening
      ? await sql`insert into assets (name, kind, method, account, acquisition_date, cost, useful_life_months, opening_date, opening_book_value)
          values ('Maschine', 'sonstige', 'linear', '0440', '2022-01-05', 500000, 120, '2026-01-01', 380000) returning id`
      : await sql`insert into assets (name, kind, method, account, acquisition_date, cost, useful_life_months)
          values ('Laptop', 'edv', 'linear', '0650', '2026-01-05', 150000, 36) returning id`;
    return a!.id as string;
  }

  it("versiegelt festgeschriebene Angebote und gebuchte Anlagen nachträglich, Entwürfe nicht", async () => {
    const angebot = await quote(true);
    const entwurf = await quote(false);
    const mitAfa = await asset();
    await sql`insert into asset_depreciations (asset_id, year, depreciation, entry_id) values (${mitAfa}, 2026, 50000, ${await entry()})`;
    const eroeffnet = await asset(true);
    await sql`update assets set opening_entry_id = ${await entry()} where id = ${eroeffnet}`;
    const ungebucht = await asset();
    expect(await sql`select * from haben_integrity_problems(100)`).toEqual([]);

    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });

    const siegel = await sql`select table_name, row_id, genesis from seals where table_name in ('quotes', 'assets') order by id`;
    expect(siegel.map((s) => [s.table_name, s.row_id, s.genesis])).toEqual([
      ["quotes", angebot, true],
      ["assets", mitAfa, true],
      ["assets", eroeffnet, true],
    ]);
    expect(siegel.map((s) => s.row_id)).not.toContain(entwurf);
    expect(siegel.map((s) => s.row_id)).not.toContain(ungebucht);
    expect(await sql`select * from haben_integrity_problems(100)`).toEqual([]);

    const rollback = new Error("rollback");
    let befunde: postgres.Row[] = [];
    await sql
      .begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update quotes set gross = 1 where id = ${angebot}`;
        await tx`update assets set cost = 1 where id = ${eroeffnet}`;
        await tx`set local session_replication_role = origin`;
        befunde = await tx`select tabelle, zeile, befund from haben_integrity_problems(100)`;
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
    expect(befunde).toEqual([
      { tabelle: "quotes", zeile: angebot, befund: "Inhalt passt nicht zum Siegel" },
      { tabelle: "assets", zeile: eroeffnet, befund: "Inhalt passt nicht zum Siegel" },
    ]);
  }, 120_000);
});
