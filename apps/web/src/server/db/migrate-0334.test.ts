import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../test-db.ts";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/*
 * Migration 0334 (#1914): Der Privatanteil steht je Zeile der Aufteilung, nicht mehr am Beleg. Ein Entwurf mit Zeilen und
 * einem Anteil am Beleg verliert ihn nicht stumm: Die Zeile mit der kleinsten Position übernimmt ihn, der Beleg geht auf 0.
 * Festschriebene Belege bleiben unberührt; ohne `locked_at IS NULL` würde ihr Trigger (documents_locked) die Migration
 * abbrechen.
 */
describe.skipIf(!testDatabaseUrl)("Migration 0334: Privatanteil je Zeile (Postgres, #1914)", () => {
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
    const idx = full.entries.findIndex((e: { tag: string }) => e.tag === "0334_privatanteil_je_zeile");
    writeFileSync(join(previous, "meta", "_journal.json"), JSON.stringify({ ...full, entries: full.entries.slice(0, idx) }));
    sql = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(drizzle(sql), { migrationsFolder: previous });
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
  });

  /** Beleg mit zwei Zeilen; `locked` schreibt ihn vor dem Lauf fest */
  const beleg = async (sha: string, privateShare: number, locked: boolean) => {
    const [doc] = await sql<{ id: string }[]>`
      insert into documents (sha256, filename, mime_type, size, net, tax, gross, private_share)
      values (${sha}, ${`${sha}.pdf`}, 'application/pdf', 100, 10000, 1900, 11900, ${privateShare})
      returning id`;
    await sql`insert into document_splits (document_id, position, category, tax_rate, net, tax)
      values (${doc!.id}, 1, 'telefon', 1900, 6000, 1140), (${doc!.id}, 2, 'internet', 1900, 4000, 760)`;
    if (locked) await sql`update documents set status = 'gebucht', locked_at = now() where id = ${doc!.id}`;
    return doc!.id;
  };

  it("übernimmt den Anteil des Entwurfs in die erste Zeile und lässt festgeschriebene Belege unberührt", async () => {
    const entwurf = await beleg("a".repeat(64), 20, false);
    const ohneAnteil = await beleg("b".repeat(64), 0, false);
    const gebucht = await beleg("c".repeat(64), 30, true);

    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });

    // Entwurf: Zeile 1 trägt den Anteil, Zeile 2 bleibt betrieblich, der Beleg geht auf 0
    expect(await sql`select position, private_share from document_splits where document_id = ${entwurf} order by position`).toEqual([
      { position: 1, private_share: 20 },
      { position: 2, private_share: 0 },
    ]);
    expect(await sql`select private_share from documents where id = ${entwurf}`).toEqual([{ private_share: 0 }]);

    // Ohne Anteil am Beleg bleibt alles, wie es war
    expect(await sql`select position, private_share from document_splits where document_id = ${ohneAnteil} order by position`).toEqual([
      { position: 1, private_share: 0 },
      { position: 2, private_share: 0 },
    ]);
    expect(await sql`select private_share from documents where id = ${ohneAnteil}`).toEqual([{ private_share: 0 }]);

    // Festgeschrieben: Anteil und Zeilen bleiben unangetastet, keine Ausnahme aus dem Trigger
    expect(await sql`select private_share from documents where id = ${gebucht}`).toEqual([{ private_share: 30 }]);
    expect(await sql`select position, private_share from document_splits where document_id = ${gebucht} order by position`).toEqual([
      { position: 1, private_share: 0 },
      { position: 2, private_share: 0 },
    ]);
  }, 120_000);
});
