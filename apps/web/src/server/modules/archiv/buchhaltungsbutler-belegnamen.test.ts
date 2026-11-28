import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";

// Belege unter ihrem Originalnamen (#1828): eine Datei an zwei Buchungen

const BB_HEADERS = [
  "Datum",
  "Buchungstext",
  "Betrag",
  "Währung",
  "Sollkonto",
  "Habenkonto",
  "Steuerschlüssel",
  "Buchungsnummer",
  "Rechnungsnummern",
  "Gegenpartei",
  "Umsatzsteuer",
  "Zugewiesene Beträge",
  "Beleglinks",
  "Festschreibung",
  "Kommentar",
  "Leistungsdatum",
];
const DATEV_HEADERS = [
  "Umsatz (ohne Soll/Haben-Kz)",
  "Soll/Haben-Kennzeichen",
  "WKZ Umsatz",
  "Konto",
  "Gegenkonto (ohne BU-Schlüssel)",
  "BU-Schlüssel",
  "Belegdatum",
  "Belegfeld 1",
  "Buchungstext",
  ...Array.from({ length: 16 }, (_, i) => `Beleginfo - ${i % 2 === 0 ? "Art" : "Inhalt"} ${Math.floor(i / 2) + 1}`),
];
const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF");

interface Row {
  id: string;
  debit: string;
  credit: string;
  bu: string;
  rate: string;
  receipt: boolean;
  amount?: string;
  /** TTMM */
  date?: string;
  number?: string;
}

const csv = (rows: string[][]) => new TextEncoder().encode(rows.map((r) => r.map((f) => `"${f}"`).join(";")).join("\r\n"));

function parts(rows: Row[], skr = "03") {
  const meta = Array.from({ length: 30 }, () => "");
  Object.assign(meta, {
    0: "EXTF",
    1: "700",
    2: "21",
    3: "Buchungsstapel",
    4: "12",
    12: "20230101",
    13: "4",
    14: "20230101",
    15: "20231231",
    21: "EUR",
    26: skr,
  });
  const datev: string[][] = [meta, DATEV_HEADERS];
  const bb: string[][] = [BB_HEADERS];
  const receipts: Record<string, Uint8Array> = {};
  for (const r of rows) {
    const amount = r.amount ?? "119,00";
    const number = r.number ?? (r.receipt ? `R-${r.id}` : "");
    const ddmm = r.date ?? "0401";
    const day = `${ddmm.slice(0, 2)}.${ddmm.slice(2)}.2023`;
    const url = r.receipt ? "https://bb.example/Sammelrechnung.pdf" : "";
    const info = [
      "Buchungsnummer",
      r.id,
      ...(r.receipt
        ? ["URL", url, "Gegenpartei", "Muster GmbH", "Rechnungsnummer", number, "Betrag", amount, "Umsatzsteuer", r.rate, "Rechnungsdatum", day]
        : []),
    ];
    // Soll/Haben-Kennzeichen S: Konto ist das Sollkonto
    datev.push([amount, "S", "EUR", r.debit, r.credit, r.bu, ddmm, number, "Muster GmbH", ...info]);
    bb.push([day, "Muster GmbH", amount, "EUR", r.debit, r.credit, r.bu, r.id, number, "Muster GmbH", r.rate, amount, url, "1", "", day]);
    if (r.receipt) receipts["Belege/Sammelrechnung.pdf"] = PDF;
  }
  return [
    { name: "EXTF_Buchungsstapel.csv", bytes: csv(datev) },
    { name: "BB_Buchungsstapel.csv", bytes: csv(bb) },
    { name: "Belege.zip", bytes: zipSync(receipts) },
  ];
}

describe.skipIf(!testDatabaseUrl)("BuchhaltungsButler: eine Belegdatei an zwei Buchungen (Postgres)", () => {
  let bb: typeof import("./buchhaltungsbutler.ts");
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = await setupTestDb();
    bb = await import("./buchhaltungsbutler.ts");
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, kontenrahmen, versteuerung, rechtsform)
      values (1, 'Nordlicht', 'Hafenallee 3', '28217', 'Bremen', 'rechnung@example.com', '60/145/12345', 'HB', 'SKR03', 'soll', 'einzelunternehmen')`;
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  it("verknüpft sie bei beiden Archivbelegen mit derselben Prüfsumme", async () => {
    const zeile = { debit: "4964", credit: "1200", bu: "9", rate: "19", receipt: true };
    await bb.startBuchhaltungsbutlerImport(
      "test-user",
      parts([
        { id: "1", ...zeile },
        { id: "2", ...zeile },
      ]),
    );
    const dateien = await sql`
      select v.lexoffice_id, f.filename, f.sha256 from lexoffice_voucher_files f join lexoffice_vouchers v on v.id = f.voucher_id order by v.lexoffice_id`;
    expect(dateien.map((d) => [d.lexoffice_id, d.filename])).toEqual([
      ["booking/2023/1", "Sammelrechnung.pdf"],
      ["booking/2023/2", "Sammelrechnung.pdf"],
    ]);
    expect(new Set(dateien.map((d) => d.sha256)).size).toBe(1);
  });
});
