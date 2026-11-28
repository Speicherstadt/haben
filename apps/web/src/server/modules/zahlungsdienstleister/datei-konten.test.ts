import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vorhandeneKonten } from "../../../routes/_app/-bank-einrichtung-konto.ts";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Die Einrichtung mit Datei (#2008) bietet kein Konto an, in das ein Abruf in Haben schreibt, auch nicht das des Etsy-Abrufs
 * (etsy_connections statt psp_connections): Eine Datei dort legte Umsätze ab dem Stichtag doppelt an (#1988).
 */

describe.skipIf(!testDatabaseUrl)("Konten für die Einrichtung mit Datei (Postgres)", () => {
  let psp: typeof import("./index.ts");
  let bank: typeof import("../bank/index.ts");
  let sql: postgres.Sql;
  const actor = "test-user";

  beforeAll(async () => {
    sql = await setupTestDb();
    psp = await import("./index.ts");
    bank = await import("../bank/index.ts");
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
  });

  it("nennt das Konto des Etsy-Abrufs als abgerufen, sobald ein Shop verbunden ist", async () => {
    const { id } = await bank.createProviderAccount(actor, { name: "Etsy", provider: "etsy" });
    await sql`insert into etsy_connections (keystring, shop_id, ciphertext, fetch_from, abruf_start) values ('k', '', '\\x00', '2026-10-01', '2026-10-01')`;
    expect(vorhandeneKonten(await psp.verbindungenUebersicht(), "etsy").map((k) => k.id)).toEqual([id]);
    await sql`update etsy_connections set shop_id = '12345'`;
    expect(vorhandeneKonten(await psp.verbindungenUebersicht(), "etsy")).toEqual([]);
  });
});
