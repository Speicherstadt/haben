import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";

describe.skipIf(!testDatabaseUrl)("Kontonamen im Journal (Postgres)", () => {
  let journal: typeof import("./journal.ts");
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = await setupTestDb();
    journal = await import("./journal.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  // Die Kategorie heißt „Privatentnahme“, das Konto weiter „Privatentnahmen“ (#1975)
  it.each([
    ["SKR03", "1800"],
    ["SKR04", "2100"],
  ] as const)("%s %s heißt Privatentnahmen", (kontenrahmen, konto) => {
    expect(journal.accountName(kontenrahmen, konto)).toBe("Privatentnahmen");
  });
});
