import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { ACTOR, firma } from "./test-liquiditaet.ts";

/*
 * Mindestbestand der Liquiditätsvorschau (#1381) gegen Postgres: speichern mit Audit, Warnung aus der Vorschau der
 * nächsten 13 Wochen für Übersicht und Fristen-Mail, ohne Mindestbestand keine. Die Warnung hängt nur am Verlauf, nicht an
 * Kontenrahmen oder Versteuerung; die decken die übrigen Tests der Vorschau ab.
 */

describe.skipIf(!testDatabaseUrl)("Liquiditätsvorschau: Mindestbestand (Postgres)", () => {
  let sql: postgres.Sql;
  let stammdaten: typeof import("../stammdaten/index.ts");
  let liquiditaet: typeof import("./index.ts");

  beforeAll(async () => {
    sql = await setupTestDb();
    stammdaten = await import("../stammdaten/index.ts");
    liquiditaet = await import("./index.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  /** Giro mit 10.000 € am 19.11.2026, Miete 5.000 € ohne Steuer per Bank je Monat ab 01.12.2026 */
  async function bestand() {
    await firma(sql, { kontenrahmen: "SKR03", versteuerung: "ist" });
    const [konto] = await sql<{ id: string }[]>`insert into bank_accounts (name, purpose, iban)
      values ('Giro', 'geschaeft', 'DE02100100100006820101') returning id`;
    await sql`insert into bank_imports (bank_account_id, filename, sha256, format, period_from, period_to, closing_balance, added, skipped)
      values (${konto!.id}, 'a.csv', ${"a".repeat(64)}, 'camt', '2026-11-01', '2026-11-19', 1000000, 1, 0)`;
    await sql`insert into recurring_documents (name, status, supplier_name, category, payment, private_share, amounts, tax_shown, kleinbetrag,
        recurrence, anchor_day, start_date, next_date, due_days, sha256, filename, mime_type, size)
      values ('Miete', 'aktiv', 'Vermieter', 'miete', 'bank', 0, ${JSON.stringify([{ taxRate: 0, net: 500_000, tax: 0 }])}::jsonb, false, false,
              'P1M', 1, '2026-01-01', '2026-12-01', 0, ${"b".repeat(64)}, 'vertrag.pdf', 'application/pdf', 1)`;
  }

  it("ohne Mindestbestand keine Warnung; gespeichert steht er im Audit-Log, in der Vorschau und warnt am ersten Tag darunter", async () => {
    await bestand();
    expect(await liquiditaet.mindestbestandWarnung("2026-11-20")).toBeNull();
    expect(await liquiditaet.mindestbestandHinweis("2026-11-20")).toBeNull();

    await stammdaten.setMindestbestand(ACTOR, 600_000);
    const [audit] = await sql<{ actor: string; neu: { mindestbestand: number } }[]>`select actor, new_value as neu from audit_log
      where table_name = 'company' order by id desc limit 1`;
    expect(audit).toMatchObject({ actor: ACTOR, neu: { mindestbestand: 600_000 } });
    expect((await liquiditaet.liquiditaetsvorschau("2026-11-20", "4w")).mindestbestand).toBe(600_000);

    // 01.12.: 10.000 € − 5.000 € = 5.000 €, 1.000 € unter 6.000 €; der Tiefpunkt am 01.02. zählt nicht
    expect(await liquiditaet.mindestbestandWarnung("2026-11-20")).toEqual({ datum: "2026-12-01", stand: 500_000, mindestbestand: 600_000, fehlt: 100_000 });
    expect(await liquiditaet.mindestbestandHinweis("2026-11-20")).toEqual({
      // formatEuro trennt das Eurozeichen mit einem geschützten Leerzeichen
      text: "Kontostand unterschreitet Mindestbestand am 01.12.2026: erwartet 5.000,00\u00a0€, 1.000,00\u00a0€ unter 6.000,00\u00a0€",
      link: "/auswertungen/liquiditaet",
    });

    // 4.000 €: erst nach der zweiten Miete; 0 € warnt erst vor dem Minus nach der dritten am 01.02.2027
    await stammdaten.setMindestbestand(ACTOR, 400_000);
    expect(await liquiditaet.mindestbestandWarnung("2026-11-20")).toEqual({ datum: "2027-01-01", stand: 0, mindestbestand: 400_000, fehlt: 400_000 });
    await stammdaten.setMindestbestand(ACTOR, 0);
    expect(await liquiditaet.mindestbestandWarnung("2026-11-20")).toMatchObject({ datum: "2027-02-01", stand: -500_000 });
    await stammdaten.setMindestbestand(ACTOR, null);
    expect(await liquiditaet.mindestbestandWarnung("2026-11-20")).toBeNull();
  });

  it("die Datenbank nimmt keinen negativen Mindestbestand", async () => {
    await bestand();
    await expect(stammdaten.setMindestbestand(ACTOR, -1)).rejects.toThrow();
  });
});
