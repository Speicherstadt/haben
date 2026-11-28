import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../test-db.ts";
import { protokollEintragen } from "./test-protokoll.ts";

// Die E2E-Tests mit einem Stand aus der Vergangenheit prüfen danach „Kette prüfen“; der Eintrag darf die Kette nicht brechen.
describe.skipIf(!testDatabaseUrl)("Zurückdatierte Einträge für Tests (Postgres)", () => {
  let sql: postgres.Sql;
  beforeAll(async () => {
    sql = await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await sql?.end();
  });

  it("trägt Einträge mit früherem Zeitpunkt ein, und Kette und Kopf bleiben stimmig", async () => {
    await protokollEintragen(sql, [
      { at: "2023-06-01T12:00:00Z", tableName: "company", rowId: "1", action: "UPDATE", newValue: { kleinunternehmer: true } },
      { at: "2023-07-01T12:00:00Z", tableName: "company", rowId: "1", action: "UPDATE", newValue: { kleinunternehmer: false } },
    ]);
    const eintraege = await sql<{ at: string; actor: string; new_value: unknown }[]>`select at, actor, new_value from audit_log order by seq desc limit 2`;
    expect(eintraege.map((e) => [new Date(e.at).toISOString(), e.actor, e.new_value])).toEqual([
      ["2023-07-01T12:00:00.000Z", "test", { kleinunternehmer: false }],
      ["2023-06-01T12:00:00.000Z", "test", { kleinunternehmer: true }],
    ]);
    expect(await sql`select art, tabelle, befund from haben_integrity_problems()`).toEqual([]);
    // Ein normaler Eintrag danach hängt sich an
    await sql`insert into company (id, name) values (1, 'Probe') on conflict (id) do update set name = 'Probe geändert'`;
    expect(await sql`select art, tabelle, befund from haben_integrity_problems()`).toEqual([]);
  });
});
