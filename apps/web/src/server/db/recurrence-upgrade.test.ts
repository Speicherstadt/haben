import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../test-db.ts";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/** Ordner mit den Migrationen bis ausschließlich bzw. einschließlich der angegebenen */
function migrationsUntil(tag: string, inclusive: boolean): string {
  const full = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const target = full.entries.find((entry) => entry.tag === tag);
  if (!target) throw new Error(`Migration ${tag} fehlt.`);
  const dir = mkdtempSync(join(tmpdir(), "haben-migration-recurrence-"));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const entries = full.entries.filter((entry) => (inclusive ? entry.idx <= target.idx : entry.idx < target.idx));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...full, entries }));
  return dir;
}

describe.skipIf(!testDatabaseUrl)("Migration 0315: Intervall als Dauer nach ISO 8601 (Postgres, #1691)", () => {
  it("rechnet bestehende Vorlagen von Monaten um und lässt nur bekannte Intervalle zu", async () => {
    const name = decodeURIComponent(new URL(testDatabaseUrl!).pathname.slice(1));
    const admin = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      await admin`drop database if exists ${admin(name)} with (force)`;
      await admin`create database ${admin(name)}`;
    } finally {
      await admin.end();
    }
    const before = migrationsUntil("0315_wiederkehrend_wochen", false);
    const until = migrationsUntil("0315_wiederkehrend_wochen", true);
    const sql = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    try {
      const database = drizzle(sql);
      await migrate(database, { migrationsFolder: before });
      // Altbestand mit dem Schema vor 0315
      await sql.begin(async (tx) => {
        await tx`select set_config('haben.actor','upgrade:altbestand',true)`;
        const [contact] = await tx`insert into contacts(name) values('Musterkunde') returning id`;
        for (const months of [1, 3, 6, 12])
          await tx`insert into recurring_invoices(name,contact_id,lines,interval_months,anchor_day,next_date)
            values(${`Vorlage ${months}`},${contact!.id},'[]'::jsonb,${months},31,'2026-12-31')`;
      });
      await migrate(database, { migrationsFolder: until });
      const rows = await sql`select name, recurrence, anchor_day, next_date::text from recurring_invoices order by name`;
      expect(rows.map((r) => [r.name, r.recurrence, r.anchor_day, r.next_date])).toEqual([
        ["Vorlage 1", "P1M", 31, "2026-12-31"],
        ["Vorlage 12", "P1Y", 31, "2026-12-31"],
        ["Vorlage 3", "P3M", 31, "2026-12-31"],
        ["Vorlage 6", "P6M", 31, "2026-12-31"],
      ]);
      expect(await sql`select column_name from information_schema.columns where table_name='recurring_invoices' and column_name like 'interval%'`).toEqual([]);
      // Die Umrechnung steht im Änderungsprotokoll, mit dem Akteur der Migration
      const audit = await sql`select count(*)::int as n from audit_log where table_name='recurring_invoices' and actor='system:migration'`;
      expect(audit[0]!.n).toBe(4);
      await expect(
        sql.begin(async (tx) => {
          await tx`select set_config('haben.actor','test',true)`;
          await tx`update recurring_invoices set recurrence='P3W' where name='Vorlage 1'`;
        }),
      ).rejects.toThrow(/recurring_recurrence/);
    } finally {
      await sql.end();
      rmSync(before, { recursive: true, force: true });
      rmSync(until, { recursive: true, force: true });
    }
  }, 120_000);
});
