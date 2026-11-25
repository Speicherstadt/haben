import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Brutto des betrieblichen Teils (#1914): 17.782 Cent netto und 3.379 Cent Steuer, eine Zeile zu 40 % privat. Betrieblich
 * bleiben 10.669 + 2.027 = 12.696 Cent. Über den Anteil am Brutto gerechnet ergäbe 21.161 * 0,6 den Gleitkomma-Rest
 * 12.695,999999999998; gebucht wird aber die Summe der betrieblichen Beträge.
 */
describe.skipIf(!testDatabaseUrl)("betrieblicherBeleg", () => {
  let sql: postgres.Sql;
  let beleg: typeof import("./beleg-anteil.ts");

  beforeAll(async () => {
    sql = await setupTestDb();
    beleg = await import("./beleg-anteil.ts");
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it("rechnet Brutto als Summe der betrieblichen Beträge, centgenau ohne Gleitkomma-Rest", () => {
    const betrieblich = beleg.betrieblicherBeleg({ net: 17_782, tax: 3_379, gross: 21_161 }, [{ base: 10_669, tax: 2_027 }]);

    expect(betrieblich).toMatchObject({ net: 10_669, tax: 2_027 });
    expect(betrieblich.gross).toBe(12_696);
    expect(Number.isInteger(betrieblich.gross)).toBe(true);
  });
});
