import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Buchungstext einer Buchung ohne Beleg im Bankabgleich (Direkt buchen, Geldtransit): Er nennt die Buchungsart so, wie
 * sie auch im Archiv steht, nicht den internen Schlüssel wie „ustVorauszahlung“. SKR03 und SKR04, Einzelunternehmen und GmbH.
 */

const IBAN = "DE12120300001234567890";
const STEUER_IBAN = "DE02120300000000202051";

function dkbCsv(rows: [date: string, name: string, iban: string, purpose: string, amount: string][], iban = "DE12 1203 0000 1234 5678 90") {
  const header = `"Girokonto";"${iban}"\n""\n`;
  const columns = `"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"\n`;
  const body = rows
    .map(([date, name, counterIban, purpose, amount]) => {
      const out = amount.startsWith("-");
      return [date, date, "Gebucht", out ? "Nordlicht" : name, out ? name : "Nordlicht", purpose, out ? "Ausgang" : "Eingang", counterIban, amount, "", "", ""]
        .map((c) => `"${c}"`)
        .join(";");
    })
    .join("\n");
  return { bytes: new TextEncoder().encode(`﻿${header}${columns}${body}\n`), filename: "auszug.csv" };
}

describe.skipIf(!testDatabaseUrl)("Buchungstext ohne Beleg (Postgres)", () => {
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
    await leeren(sql)`truncate allocations, bank_transactions, bank_imports, bank_accounts, journal_lines, journal_entries, company cascade`;
  });

  async function firma(kontenrahmen: "SKR03" | "SKR04", rechtsform: "einzelunternehmen" | "gmbh") {
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, kontenrahmen, versteuerung, rechtsform)
      values (1, 'Nordlicht', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'BY',
              ${kontenrahmen}, 'ist', ${rechtsform})`;
  }

  const texte = async () =>
    (await sql`select distinct description from journal_entries where source_type = 'allocation' order by description`).map((r) => r.description as string);

  it.each(["SKR03", "SKR04"] as const)(
    "%s, Einzelunternehmen: Direkt buchen nennt die Buchungsart, nicht den Schlüssel",
    async (kontenrahmen) => {
      await firma(kontenrahmen, "einzelunternehmen");
      await bank.importStatement(
        actor,
        dkbCsv([
          ["10.10.26", "Finanzamt Regensburg", "DE76750000000075001007", "USt 09/2026", "-412,30"],
          ["30.10.26", "Sparkasse", "", "Kontoführung", "-9,90"],
          ["31.10.26", "Mia Muster", "DE02100100100006820101", "Entnahme", "-500,00"],
        ]),
        null,
      );
      const rows = await sql`select id, amount from bank_transactions order by booking_date`;
      const arten = ["ustVorauszahlung", "gebuehren", "privat"] as const;
      for (const [i, row] of rows.entries()) await bank.allocate(actor, { kind: arten[i]!, transactionId: row.id as string, amount: row.amount as number });
      expect(await texte()).toEqual(["Finanzamt Regensburg · USt-Vorauszahlung", "Mia Muster · Privat", "Sparkasse · Bankgebühren"]);
    },
    30_000,
  );

  it.each(["SKR03", "SKR04"] as const)(
    "%s, GmbH: Geld an den Gesellschafter nennt das Verrechnungskonto",
    async (kontenrahmen) => {
      await firma(kontenrahmen, "gmbh");
      await bank.importStatement(actor, dkbCsv([["31.10.26", "Max Muster", "DE02100100100006820101", "Auslagen", "-300,00"]]), null);
      const [row] = await sql`select id, amount from bank_transactions`;
      await bank.allocate(actor, { kind: "privat", transactionId: row!.id as string, amount: row!.amount as number });
      expect(await texte()).toEqual(["Max Muster · Gesellschafter (Verrechnungskonto)"]);
    },
    30_000,
  );

  it.each(["SKR03", "SKR04"] as const)(
    "%s: Geldtransit zwischen zwei eigenen Konten",
    async (kontenrahmen) => {
      await firma(kontenrahmen, "einzelunternehmen");
      await bank.importStatement(actor, dkbCsv([["01.10.26", "Steuerkonto", STEUER_IBAN, "Rücklage USt", "-600,00"]]), null);
      await bank.importStatement(actor, dkbCsv([["02.10.26", "Nordlicht", IBAN, "Rücklage USt", "600,00"]], "DE02 1203 0000 0000 2020 51"), null);
      const [out] = await sql`select id from bank_transactions where amount = -60000`;
      const [into] = await sql`select id from bank_transactions where amount = 60000`;
      await bank.allocateTransfer(actor, { transactionId: out!.id, counterpartId: into!.id });
      expect(await texte()).toEqual(["Nordlicht · Geldtransit", "Steuerkonto · Geldtransit"]);
    },
    30_000,
  );
});
