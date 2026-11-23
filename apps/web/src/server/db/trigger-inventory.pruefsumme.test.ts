import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sql as query } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../test-db.ts";
import { checkTriggerInventory } from "./trigger-inventory.ts";

/*
 * Die Prüfsumme der Sperren (#1683): „Kette prüfen“ zeigt sie für den eigenen Bestand, der Release-Workflow schreibt die
 * des ausgelieferten Sollbestands mit scripts/sollbestand/pruefsumme.ts in die Release Notes. Eine frisch migrierte
 * Datenbank muss dieselbe haben, auf jeder unterstützten Version von PostgreSQL; die CI lässt diesen Test deshalb auch auf
 * der ältesten Unterversion laufen (Job sollbestand-postgres in ci.yml).
 */
describe.skipIf(!testDatabaseUrl)("Prüfsumme der Sperren (Postgres)", () => {
  let sql: postgres.Sql;
  beforeAll(async () => {
    sql = await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await sql?.end();
  });

  const releaseSumme = () => {
    const skript = fileURLToPath(new URL("../../../../../scripts/sollbestand/pruefsumme.ts", import.meta.url));
    const ergebnis = spawnSync(process.execPath, [skript], { encoding: "utf8" });
    expect(ergebnis.stderr).toBe("");
    return ergebnis.stdout.trim();
  };

  it("ist für eine frisch migrierte Datenbank die aus den Release Notes", async () => {
    const [server] = await sql<{ version: string }[]>`select current_setting('server_version') as version`;
    const { problems, checksum } = await checkTriggerInventory(drizzle(sql));
    expect(problems).toEqual([]);
    expect(checksum.own).toMatch(/^[0-9a-f]{64}$/);
    expect(checksum, `PostgreSQL ${server!.version}`).toEqual({ own: releaseSumme(), shipped: releaseSumme() });
  });

  it("ändert sich mit einem abgeschalteten Trigger", async () => {
    const rollback = new Error("Gegenprobe zurückrollen");
    await drizzle(sql)
      .transaction(async (tx) => {
        await tx.execute(query`alter table public.year_closings disable trigger year_closings_append_only`);
        const { checksum } = await checkTriggerInventory(tx as unknown as ReturnType<typeof drizzle>);
        expect(checksum.own).not.toBe(checksum.shipped);
        throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });
  });
});
