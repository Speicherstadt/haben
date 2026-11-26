import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StripeBalanceTransaction, StripeClient } from "@haben/import";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Konto der Quellenbindung (#306) beim Speichern einer Verbindung (#1729): Nach dem Entfernen kann eine andere Verbindung das
 * gebundene Konto übernommen haben. Die erneute Verbindung zum alten Stripe-Konto muss das mit einer Meldung sagen, statt an
 * der Datenbank zu scheitern. Der Stripe-Client ist nachgebaut; Kennungen und Beträge sind erfunden.
 */

const HEUTE = new Date("2026-11-07T10:00:00Z");

const KONTEN: Record<string, string> = { rk_live_alteaaaaaaaaaa: "acct_alt", rk_live_andereaaaaaaaa: "acct_andere" };

const fake = (apiKey: string) =>
  ({
    accountId: async () => KONTEN[apiKey] ?? "acct_unbekannt",
    balanceTransactions: async () => [
      {
        id: `txn_${KONTEN[apiKey]}`,
        object: "balance_transaction",
        amount: 1000,
        created: Math.floor(Date.parse("2026-11-05T09:00:00Z") / 1000),
        currency: "eur",
        description: "Zahlung",
        fee: 0,
        net: 1000,
        reporting_category: "charge",
        source: `ch_${KONTEN[apiKey]}`,
        status: "available",
        type: "charge",
      } as StripeBalanceTransaction,
    ],
  }) as unknown as StripeClient;

describe.skipIf(!testDatabaseUrl)("Verbindung zu einem schon gebundenen Konto des Anbieters (Postgres)", () => {
  let psp: typeof import("./index.ts");
  let sql: postgres.Sql;
  const actor = "test-user";

  beforeAll(async () => {
    sql = await setupTestDb();
    psp = await import("./index.ts");
    psp.setStripeClientFactory((options) => fake(options.apiKey));
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
  });

  it("meldet, welche Verbindung das gebundene Konto inzwischen nutzt, statt an der Datenbank zu scheitern", async () => {
    const erste = await psp.speichereVerbindung(actor, {
      provider: "stripe",
      name: "Alt",
      eingabe: { apiKey: "rk_live_alteaaaaaaaaaa" },
      fetchFrom: "2026-11-01",
    });
    expect((await psp.abrufen(actor, erste, HEUTE)).error).toBeNull();
    const gebunden = (await psp.ladeVerbindung(erste))!.row.bankAccountId;
    await psp.entferneVerbindung(actor, erste);
    // „Automatisch“ gibt das nun freie Konto einer anderen Verbindung
    const andere = await psp.speichereVerbindung(actor, {
      provider: "stripe",
      name: "Andere",
      eingabe: { apiKey: "rk_live_andereaaaaaaaa" },
      fetchFrom: "2026-11-01",
    });
    expect((await psp.ladeVerbindung(andere))!.row.bankAccountId).toBe(gebunden);
    const wieder = psp.speichereVerbindung(actor, {
      provider: "stripe",
      name: "Alt wieder",
      eingabe: { apiKey: "rk_live_alteaaaaaaaaaa" },
      fetchFrom: "2026-11-01",
    });
    await expect(wieder).rejects.toBeInstanceOf(psp.ZahlungsdienstleisterError);
    await expect(wieder).rejects.toThrow("„Andere“");
  });
});
