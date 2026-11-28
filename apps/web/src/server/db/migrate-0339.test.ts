import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../test-db.ts";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/*
 * Migration 0339 (#861): Bankumsätze, Kontaktversionen, DATEV-Buchungen und Lexoffice-Belege standen nicht im Audit-Log.
 * Vorhandene Zeilen trägt die Migration nachträglich ein, ebenso Zeilen anderer nur anhängbarer Tabellen, die dort fehlen;
 * danach meldet der neue Abgleich nichts, und die Kette hält.
 */
describe.skipIf(!testDatabaseUrl)("Migration 0339: Bestand der nur anhängbaren Tabellen ins Audit-Log (Postgres)", () => {
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
    const idx = full.entries.findIndex((e: { tag: string }) => e.tag === "0339_abgleich_audit_log");
    writeFileSync(join(previous, "meta", "_journal.json"), JSON.stringify({ ...full, entries: full.entries.slice(0, idx) }));
    sql = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(drizzle(sql), { migrationsFolder: previous });
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
  });

  it("trägt vorhandene Zeilen nachträglich ein, mit Hinweis, und der Abgleich bleibt ohne Befund", async () => {
    const vorher = await sql.begin(async (tx) => {
      await tx`select set_config('haben.actor', 'test:vorher', true)`;
      const [konto] = await tx`insert into bank_accounts (name, iban) values ('Giro', 'DE89370400440532013000') returning id`;
      const [abruf] = await tx`insert into bank_imports (bank_account_id, filename, sha256, format, added, skipped)
        values (${konto!.id}, 'Auszug', ${"a".repeat(64)}, 'camt', 2, 0) returning id`;
      const umsaetze = await tx`insert into bank_transactions (bank_account_id, import_id, booking_date, amount, purpose, dedup_hash)
        values (${konto!.id}, ${abruf!.id}, '2026-11-12', -4999, 'Miete', 'h1'), (${konto!.id}, ${abruf!.id}, '2026-11-13', 12000, 'Rechnung 7', 'h2')
        returning id`;
      const [kontakt] = await tx`insert into contacts (name) values ('Kunde A') returning id`;
      await tx`update contacts set name = 'Kunde A GmbH' where id = ${kontakt!.id}`;
      // Eine Zeile, die schon vor 0339 an den Triggern vorbei in eine auditierte Tabelle kam: auch sie wird eingetragen
      await tx`set local session_replication_role = replica`;
      const [zugang] = await tx`insert into user_logins (user_id, role, method) values ('nutzer-1', 'owner', 'passwort') returning id::text as id`;
      await tx`set local session_replication_role = origin`;
      return { umsaetze: umsaetze.map((u) => u.id as string), zugang: zugang!.id as string };
    });
    const versionen = await sql`select id::text as id from contact_versions`;
    expect(versionen.length).toBeGreaterThan(0);
    expect(await sql`select * from haben_integrity_problems(100)`).toEqual([]);
    const [kopf] = await sql`select seq from audit_chain`;

    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });

    const nachgetragen = await sql`select table_name, row_id, actor, new_value from audit_log where seq > ${kopf!.seq} order by seq`;
    const zeilen = (tabelle: string) => nachgetragen.filter((e) => e.table_name === tabelle).map((e) => e.row_id);
    expect(zeilen("bank_transactions").sort()).toEqual([...vorher.umsaetze].sort());
    expect(zeilen("contact_versions").sort()).toEqual(versionen.map((v) => v.id).sort());
    expect(zeilen("user_logins")).toEqual([vorher.zugang]);
    expect(nachgetragen.every((e) => e.actor === "system:migration")).toBe(true);
    // Hinweis wie beim nachträglichen Bilden der Kette (0063): danach, mit der Anzahl je Tabelle. Den Stichtag der Hashes
    // legt erst die spätere Migration 0354 an (#2038).
    expect(nachgetragen.filter((e) => e.table_name !== "audit_hash_since").at(-1)).toMatchObject({
      table_name: "audit_chain",
      new_value: {
        hinweis: expect.stringContaining("nachträglich eingetragen"),
        tabellen: { bank_transactions: 2, contact_versions: versionen.length, user_logins: 1 },
      },
    });
    expect(await sql`select * from haben_integrity_problems(100)`).toEqual([]);
  }, 120_000);
});
