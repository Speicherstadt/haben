import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../test-db.ts";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/*
 * Migration 0317 (#1678): Der Standard „Mahnung“ aus 0313 galt für jede Stufe. Er wird Standard der Stufe „1. Mahnung“,
 * für Zahlungserinnerung und letzte Mahnung kommt je eine Kopie dazu, damit jede Stufe denselben Text behält. Andere
 * Bausteine bleiben, wie sie sind; das Änderungsprotokoll nennt die Migration als Urheber und die Hash-Kette hält.
 */
describe.skipIf(!testDatabaseUrl)("Migration 0317: Standard je Mahnstufe (Postgres, #1678)", () => {
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
    const idx = full.entries.findIndex((e: { tag: string }) => e.tag === "0317_standard_je_mahnstufe");
    writeFileSync(join(previous, "meta", "_journal.json"), JSON.stringify({ ...full, entries: full.entries.slice(0, idx) }));
    sql = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(drizzle(sql), { migrationsFolder: previous });
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
  });

  // 200 UTF-16-Einheiten wie im Formular erlaubt; die Kopien bleiben darunter (179 und 183 Einheiten)
  const EMOJI = "😀".repeat(100);

  it("verteilt den Standard „Mahnung“ auf die drei Stufen und lässt andere Bausteine", async () => {
    await sql.begin(async (tx) => {
      await tx`select set_config('haben.actor', 'test:vorher', true)`;
      await tx`insert into text_blocks (name, kind, text, standard_fuer) values
        ('Offen', 'kopf', 'Unsere Rechnung ist noch offen.', 'mahnung'),
        (${EMOJI}, 'fuss', 'Bei Rückfragen rufen Sie mich gern an.', 'mahnung'),
        ('Einleitung', 'kopf', 'Für die Wartung berechne ich Ihnen:', 'rechnung'),
        ('Dank', 'fuss', 'Vielen Dank!', null)`;
    });
    expect(await sql`select * from haben_integrity_problems(100)`).toEqual([]);

    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });

    expect(await sql`select name, kind, text, standard_fuer from text_blocks order by standard_fuer nulls first, kind desc`).toEqual([
      { name: "Dank", kind: "fuss", text: "Vielen Dank!", standard_fuer: null },
      { name: "Offen (Zahlungserinnerung)", kind: "kopf", text: "Unsere Rechnung ist noch offen.", standard_fuer: "mahnstufe_1" },
      { name: `${"😀".repeat(79)} (Zahlungserinnerung)`, kind: "fuss", text: "Bei Rückfragen rufen Sie mich gern an.", standard_fuer: "mahnstufe_1" },
      { name: "Offen", kind: "kopf", text: "Unsere Rechnung ist noch offen.", standard_fuer: "mahnstufe_2" },
      { name: EMOJI, kind: "fuss", text: "Bei Rückfragen rufen Sie mich gern an.", standard_fuer: "mahnstufe_2" },
      { name: "Offen (Letzte Mahnung)", kind: "kopf", text: "Unsere Rechnung ist noch offen.", standard_fuer: "mahnstufe_3" },
      { name: `${"😀".repeat(83)} (Letzte Mahnung)`, kind: "fuss", text: "Bei Rückfragen rufen Sie mich gern an.", standard_fuer: "mahnstufe_3" },
      { name: "Einleitung", kind: "kopf", text: "Für die Wartung berechne ich Ihnen:", standard_fuer: "rechnung" },
    ]);
    const urheber = await sql`select distinct actor from audit_log where table_name = 'text_blocks' and actor <> 'test:vorher'`;
    expect(urheber).toEqual([{ actor: "system:migration" }]);
    expect(await sql`select * from haben_integrity_problems(100)`).toEqual([]);
    // „Mahnung“ ist kein Wert mehr; je Stufe und Art höchstens ein Standard
    await expect(sql`insert into text_blocks (name, kind, text, standard_fuer) values ('Alt', 'kopf', 'x', 'mahnung')`).rejects.toThrow(
      /text_blocks_standard_fuer/,
    );
    await expect(sql`insert into text_blocks (name, kind, text, standard_fuer) values ('Zweiter', 'kopf', 'x', 'mahnstufe_3')`).rejects.toThrow(
      /text_blocks_standard/,
    );
  }, 120_000);
});
