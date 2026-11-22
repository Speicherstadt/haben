import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Saldenprüfung über Importe hinweg (#1643): Ein kurzer Export, dessen Zeitraum sich mit einem vorhandenen Import
 * überschneidet, darf keine Lücke melden, sondern den Überschneidungshinweis. Haben verglich sonst mit einem
 * älteren Import und stellte dessen Endsaldo einem Zwischenstand der neuen Datei gegenüber.
 */

const IBAN = "DE12120300001234567890";

/** DKB-Auszug wie in bank.test.ts: Kopfzeile mit Kontostand, eine Zeile je Umsatz */
function dkbCsv(rows: string[][], balance: string, date: string) {
  const header = `"Girokonto";"${IBAN}"\n""\n"Kontostand vom ${date}:";"${balance}"\n""\n`;
  const columns = `"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"\n`;
  const body = rows.map((r) => r.map((c) => `"${c}"`).join(";")).join("\n");
  return new TextEncoder().encode(`﻿${header}${columns}${body}\n`);
}

const eingang = (date: string, zweck: string, betrag: string) => [
  date,
  date,
  "Gebucht",
  "Beispiel AG",
  "Testkonto",
  zweck,
  "Eingang",
  "DE89370400440532013000",
  betrag,
  "",
  "",
  "",
];

describe.skipIf(!testDatabaseUrl)("Saldenprüfung bei überlappenden Importen (Postgres)", () => {
  let bank: typeof import("./index.ts");
  let sql: postgres.Sql;
  const actor = "test-user";

  beforeAll(async () => {
    sql = await setupTestDb();
    bank = await import("./index.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    await leeren(sql)`truncate allocations, bank_transactions, bank_imports, bank_accounts, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, telefon, steuernummer, ust_id, bundesland, iban, versteuerung, kontenrahmen)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '+49 941 1', '198/113/10010',
              'DE123456789', 'BY', 'DE89370400440532013000', 'ist', 'SKR03')`;
  });

  it("meldet keine Lücke, wenn sich der kurze Export mit dem Jahresexport überschneidet", async () => {
    // Vorjahr: 900,00 € + 100,00 € = 1.000,00 €
    expect(
      await bank.importStatement(
        actor,
        { bytes: dkbCsv([eingang("15.06.25", "RE 2025-001", "100,00")], "1.000,00 €", "31.12.2025"), filename: "a-2025.csv" },
        null,
      ),
    ).toMatchObject({ added: 1, skipped: 0, gap: null });

    // Jahresexport 2026 mit 20.04.2026 und 17.11.2026: 1.000,00 € + 450,00 € + 50,00 € = 1.500,00 €
    expect(
      await bank.importStatement(
        actor,
        {
          bytes: dkbCsv([eingang("20.04.26", "RE 2026-001", "450,00"), eingang("17.11.26", "RE 2026-002", "50,00")], "1.500,00 €", "19.11.2026"),
          filename: "b-2026.csv",
        },
        null,
      ),
    ).toMatchObject({ added: 2, skipped: 0, gap: null });

    // Kurzexport mit demselben Umsatz vom 17.11.2026: sein Anfangssaldo ist ein Zwischenstand, kein Jahresabschluss
    const kurz = await bank.importStatement(
      actor,
      { bytes: dkbCsv([eingang("17.11.26", "RE 2026-002", "50,00")], "1.500,00 €", "21.11.2026"), filename: "c-kurz.csv" },
      null,
    );
    expect(kurz).toMatchObject({ added: 0, skipped: 1 });
    expect(kurz.gap).toBeNull();
    expect(kurz.warnings.join(" ")).toMatch(/überschneidet sich mit einem vorhandenen Import \(bis 19\.11\.2026\)/);
  });

  it("meldet weiterhin eine Lücke, wenn sich der Zeitraum nicht überschneidet", async () => {
    expect(
      await bank.importStatement(
        actor,
        { bytes: dkbCsv([eingang("15.06.25", "RE 2025-001", "100,00")], "1.000,00 €", "31.12.2025"), filename: "a-2025.csv" },
        null,
      ),
    ).toMatchObject({ added: 1, skipped: 0, gap: null });

    expect(
      await bank.importStatement(
        actor,
        {
          bytes: dkbCsv([eingang("20.04.26", "RE 2026-001", "450,00"), eingang("17.11.26", "RE 2026-002", "50,00")], "1.500,00 €", "19.11.2026"),
          filename: "b-2026.csv",
        },
        null,
      ),
    ).toMatchObject({ added: 2, skipped: 0, gap: null });

    // Ab 20.11.2026, also nach dem Jahresexport: Anfangssaldo 1.800,00 € passt nicht zu dessen Endsaldo 1.500,00 €
    const danach = await bank.importStatement(
      actor,
      { bytes: dkbCsv([eingang("20.11.26", "RE 2026-003", "50,00")], "1.850,00 €", "31.12.2026"), filename: "d-danach.csv" },
      null,
    );
    expect(danach).toMatchObject({ added: 1, skipped: 0 });
    expect(danach.gap).toMatch(/^Lücke: Anfangssaldo 1\.800,00\s€ passt nicht zum Endsaldo 1\.500,00\s€ \(Stand 19\.11\.2026\)/);
    expect(danach.warnings.join(" ")).not.toMatch(/überschneidet/);
  });

  it("meldet die Lücke vor dem Anfang, auch wenn das Ende einen später importierten Zeitraum überschneidet", async () => {
    // 2025: 900,00 € + 100,00 € = 1.000,00 €
    expect(
      await bank.importStatement(
        actor,
        { bytes: dkbCsv([eingang("15.06.25", "RE 2025-001", "100,00")], "1.000,00 €", "31.12.2025"), filename: "a-2025.csv" },
        null,
      ),
    ).toMatchObject({ added: 1, skipped: 0, gap: null });

    // Zweites Halbjahr 2026 zuerst importiert, Zeitraum 30.06.2026–31.12.2026
    expect(
      await bank.importStatement(
        actor,
        { bytes: dkbCsv([eingang("30.06.26", "RE 2026-002", "50,00")], "2.000,00 €", "31.12.2026"), filename: "c-2026-2.csv" },
        null,
      ),
    ).toMatchObject({ added: 1, skipped: 0 });

    // Nachgeholt ab 01.03.2026: Anfangssaldo 1.250,00 € − 150,00 € = 1.100,00 € statt 1.000,00 €, Januar und Februar
    // fehlen. Nur das Ende (30.06.2026) überschneidet sich mit dem zweiten Halbjahr; die Lücke liegt am Anfang.
    const nachgeholt = await bank.importStatement(
      actor,
      {
        bytes: dkbCsv([eingang("01.03.26", "RE 2026-001", "100,00"), eingang("30.06.26", "RE 2026-002", "50,00")], "1.250,00 €", "30.06.2026"),
        filename: "b-2026-1.csv",
      },
      null,
    );
    expect(nachgeholt).toMatchObject({ added: 1, skipped: 1 });
    expect(nachgeholt.gap).toMatch(/^Lücke: Anfangssaldo 1\.100,00\s€ passt nicht zum Endsaldo 1\.000,00\s€ \(Stand 31\.12\.2025\)/);
    expect(nachgeholt.warnings.join(" ")).not.toMatch(/überschneidet/);
  });

  it("wählt keinen späteren leeren Auszug als vorigen Import", async () => {
    // 2025: 900,00 € + 100,00 € = 1.000,00 €
    expect(
      await bank.importStatement(
        actor,
        { bytes: dkbCsv([eingang("15.06.25", "RE 2025-001", "100,00")], "1.000,00 €", "31.12.2025"), filename: "a-2025.csv" },
        null,
      ),
    ).toMatchObject({ added: 1, skipped: 0, gap: null });

    // Leerer Auszug mit Kontostand am 31.12.2026, also nach dem Halbjahr 2026
    expect(await bank.importStatement(actor, { bytes: dkbCsv([], "1.200,00 €", "31.12.2026"), filename: "b-leer-2026.csv" }, null)).toMatchObject({
      added: 0,
      skipped: 0,
    });

    // Halbjahr 2026: Anfang 1.000,00 € passt zum Endsaldo 2025; der spätere leere Auszug darf nicht stören
    const halbjahr = await bank.importStatement(
      actor,
      { bytes: dkbCsv([eingang("20.04.26", "RE 2026-001", "100,00")], "1.100,00 €", "30.06.2026"), filename: "c-halbjahr.csv" },
      null,
    );
    expect(halbjahr).toMatchObject({ added: 1, skipped: 0, gap: null });
    expect(halbjahr.warnings.join(" ")).not.toMatch(/überschneidet/);
  });

  it("meldet einen Hinweis, wenn ein leerer Auszug mit Kontostand in einen vorhandenen Zeitraum fällt", async () => {
    // Jahresexport 2026: 1.000,00 € + 450,00 € + 50,00 € = 1.500,00 €, Zeitraum 20.04.2026–31.12.2026
    expect(
      await bank.importStatement(
        actor,
        {
          bytes: dkbCsv([eingang("20.04.26", "RE 2026-001", "450,00"), eingang("17.11.26", "RE 2026-002", "50,00")], "1.500,00 €", "31.12.2026"),
          filename: "a-2026.csv",
        },
        null,
      ),
    ).toMatchObject({ added: 2, skipped: 0, gap: null });

    // Leerer Auszug mit Kontostand am 30.06.2026: liegt mitten im Jahresexport, sein Saldo ist ein Zwischenstand
    const leer = await bank.importStatement(actor, { bytes: dkbCsv([], "1.800,00 €", "30.06.2026"), filename: "b-leer.csv" }, null);
    expect(leer).toMatchObject({ added: 0, skipped: 0 });
    expect(leer.gap).toBeNull();
    expect(leer.warnings.join(" ")).toMatch(/überschneidet sich mit einem vorhandenen Import \(bis 31\.12\.2026\)/);
  });

  it("nimmt einen leeren Auszug mit Kontostand als vorigen Import", async () => {
    expect(
      await bank.importStatement(
        actor,
        { bytes: dkbCsv([eingang("15.06.24", "RE 2024-001", "100,00")], "1.000,00 €", "31.12.2024"), filename: "a-2024.csv" },
        null,
      ),
    ).toMatchObject({ added: 1, skipped: 0, gap: null });

    // Leerer Auszug mit Kontostand: kein Umsatz, aber ein Endsaldo am 31.12.2025
    expect(await bank.importStatement(actor, { bytes: dkbCsv([], "1.200,00 €", "31.12.2025"), filename: "b-leer.csv" }, null)).toMatchObject({
      added: 0,
      skipped: 0,
    });

    // Der nächste Auszug schließt an den leeren Auszug an, nicht an den von 2024
    const danach = await bank.importStatement(
      actor,
      { bytes: dkbCsv([eingang("20.11.26", "RE 2026-001", "50,00")], "1.250,00 €", "31.12.2026"), filename: "c-2026.csv" },
      null,
    );
    expect(danach).toMatchObject({ added: 1, skipped: 0, gap: null });
    expect(danach.warnings.join(" ")).not.toMatch(/überschneidet/);
  });
});
