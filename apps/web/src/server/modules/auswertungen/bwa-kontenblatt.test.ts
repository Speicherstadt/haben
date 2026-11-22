import { ACCOUNTS, bwaZeitraum, LOHN_KONTEN } from "@haben/core";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import type { EmployeeInput } from "../lohn/employees.ts";

/*
 * Drilldown der BWA (#1635): Lohn- und Umsatzsteuerzahlungen haben keinen Beleg. Die BWA nennt deshalb Buchung und Konto,
 * und die Buchung steht im Kontenblatt dieses Kontos am Tag der Zahlung. Namen, Beträge und IBANs sind erfunden.
 */

const ANGESTELLTER: EmployeeInput = {
  vorname: "Alex",
  nachname: "Beispiel",
  strasse: "Beispielweg 2",
  plz: "28195",
  ort: "Bremen",
  geburtsdatum: "1985-04-12",
  steuerId: "47291830467",
  steuerklasse: 1,
  konfession: null,
  art: "beschaeftigt",
  monatsgehalt: 3200_00,
  krankenversicherung: "gesetzlich",
  zusatzbeitrag: 310,
  kinderlosenzuschlag: false,
  kinderUnter25: 4,
  u1Satz: 160,
  u2Satz: 44,
  personengruppe: "101",
  beitragsgruppen: "1111",
  taetigkeitsschluessel: "431143111",
  svNummer: "12120480m123",
  krankenkasse: "Beispielkasse",
  krankenkasseBetriebsnummer: "15027365",
  statusfeststellung: "",
  eintritt: "2026-01-01",
  iban: "DE02120300000000202051",
};

/** Kontoauszug im DKB-Format: je Zeile Empfänger, Zweck und Betrag in Cent, alle am selben Tag (TT.MM.JJ) */
function dkbCsv(rows: [empfaenger: string, zweck: string, betrag: number][], tag = "10.11.26") {
  const header = `"Girokonto";"DE89370400440532013000"\n""\n`;
  const columns = `"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"\n`;
  const euro = (c: number) => `-${(Math.abs(c) / 100).toFixed(2).replace(".", ",")}`;
  const body = rows.map(([an, zweck, betrag]) =>
    [tag, tag, "Gebucht", "Testfirma", an, zweck, "Ausgang", "DE02100100100006820101", euro(betrag), "", "", ""].map((c) => `"${c}"`).join(";"),
  );
  return new TextEncoder().encode(`${header + columns + body.join("\n")}\n`);
}

describe.skipIf(!testDatabaseUrl)("BWA: Lohn- und Umsatzsteuerzahlungen im Kontenblatt (Postgres, #1635)", () => {
  let sql: postgres.Sql;
  let bank: typeof import("../bank/index.ts");
  let lohn: typeof import("../lohn/index.ts");
  let buchhaltung: typeof import("../buchhaltung/index.ts");
  let bwa: typeof import("./bwa.ts");
  const actor = "bwa-kontenblatt-test";

  beforeAll(async () => {
    sql = await setupTestDb();
    bank = await import("../bank/index.ts");
    lohn = await import("../lohn/index.ts");
    buchhaltung = await import("../buchhaltung/index.ts");
    bwa = await import("./bwa.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function firma(versteuerung: "ist" | "soll", kontenrahmen: "SKR03" | "SKR04") {
    await leeren(sql)`truncate vat_returns, allocations, bank_transactions, bank_imports, bank_accounts, journal_lines, journal_entries, year_closings,
      payslip_cancellations, payslips, payroll_runs, employees, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, iban, kontenrahmen, versteuerung, rechtsform)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'BY',
              'DE89370400440532013000', ${kontenrahmen}, ${versteuerung}, 'einzelunternehmen')`;
  }

  /** Lohn Oktober festgeschrieben, am 10.11. bezahlt, dazu am selben Tag eine Umsatzsteuer-Vorauszahlung */
  async function zahlungen(kontenrahmen: "SKR03" | "SKR04") {
    await lohn.saveEmployee(actor, null, ANGESTELLTER);
    await lohn.abrechnen(actor, { year: 2026, month: 10, zahltag: "2026-11-10" });
    const [entwurf] = await sql<{ id: string }[]>`select id from payslips where locked_at is null`;
    await lohn.festschreiben(actor, { id: entwurf!.id, gegengeprueft: true }, "2026-11-02");
    const [offen] = await sql<{ betrag: number }[]>`
      select (coalesce(sum(credit), 0) - coalesce(sum(debit), 0))::int as betrag from journal_lines where account = ${LOHN_KONTEN[kontenrahmen].verbLohn}`;
    await bank.importStatement(
      actor,
      {
        bytes: dkbCsv([
          ["Alex Beispiel", "Lohn Oktober", offen!.betrag],
          ["Finanzamt Regensburg", "USt 09/26", 1_234_00],
        ]),
        filename: `${crypto.randomUUID()}.csv`,
      },
      null,
    );
    const txs = await sql<{ id: string; amount: number; purpose: string }[]>`select id, amount, purpose from bank_transactions`;
    for (const t of txs) await bank.allocate(actor, { kind: t.purpose === "USt 09/26" ? "ustVorauszahlung" : "lohn", transactionId: t.id, amount: t.amount });
    return offen!.betrag;
  }

  for (const kontenrahmen of ["SKR03", "SKR04"] as const) {
    for (const versteuerung of ["ist", "soll"] as const) {
      it(`Drilldown nennt Buchung und Konto, die Buchung steht im Kontenblatt am Tag der Zahlung (${kontenrahmen}, ${versteuerung})`, async () => {
        await firma(versteuerung, kontenrahmen);
        const lohnzahlung = await zahlungen(kontenrahmen);
        const november = bwaZeitraum("monat", 2026, 11);

        for (const [zeile, konto, betrag] of [
          ["personal", LOHN_KONTEN[kontenrahmen].verbLohn, lohnzahlung],
          ["ustZahlung", ACCOUNTS[kontenrahmen].ustVorauszahlung, 1_234_00],
        ] as const) {
          const vorgaenge = (await bwa.bwaZeileDetails(november, zeile)).flatMap((g) => g.vorgaenge);
          expect(
            vorgaenge.map((v) => [v.sourceType, v.datum, v.betrag, v.konto]),
            zeile,
          ).toEqual([["allocation", "2026-11-10", betrag, konto]]);
          const [v] = vorgaenge;
          const [eintrag] = await sql<{ id: string }[]>`
            select e.id from journal_entries e join allocations a on a.id = e.source_id where e.source_type = 'allocation' and e.source_id = ${v!.sourceId}`;
          expect(v!.buchungId, zeile).toBe(eintrag!.id);
          const blatt = await buchhaltung.kontenblatt(v!.konto!, buchhaltung.ledgerRangeVonBis({ von: v!.datum, bis: v!.datum }));
          expect(
            blatt.zeilen.filter((z) => z.entryId === v!.buchungId).map((z) => [z.date, z.soll]),
            zeile,
          ).toEqual([["2026-11-10", betrag]]);
        }
      }, 60_000);

      it(`USt Dezember, gezahlt am 8. Januar: Die BWA zählt sie am 31.12., der Link führt zum Buchungstag (${kontenrahmen}, ${versteuerung})`, async () => {
        await firma(versteuerung, kontenrahmen);
        // § 11 Abs. 2 Satz 2 EStG: Die Vorauszahlung für Dezember, gezahlt bis 10. Januar, zählt im Vorjahr (euer-jahreswechsel.ts)
        const [vat] = await sql<{ id: string }[]>`
          insert into vat_returns (year, month, status, kz81, kz86, kz66, kz83, sent_at) values (2026, 12, 'sent', 0, 0, 0, 123400, now()) returning id`;
        await bank.importStatement(actor, { bytes: dkbCsv([["Finanzamt Regensburg", "USt 12/26", 1_234_00]], "08.01.27"), filename: "fa.csv" }, null);
        const [t] = await sql<{ id: string; amount: number }[]>`select id, amount from bank_transactions`;
        await bank.allocate(actor, { kind: "ustva", transactionId: t!.id, vatReturnId: vat!.id, amount: t!.amount });

        const vorgaenge = (await bwa.bwaZeileDetails(bwaZeitraum("monat", 2026, 12), "ustZahlung")).flatMap((g) => g.vorgaenge);
        expect(vorgaenge.map((v) => [v.datum, v.buchungsdatum, v.betrag, v.konto])).toEqual([
          ["2026-12-31", "2027-01-08", 1_234_00, ACCOUNTS[kontenrahmen].ustVorauszahlung],
        ]);
        const [v] = vorgaenge;
        const blatt = await buchhaltung.kontenblatt(v!.konto!, buchhaltung.ledgerRangeVonBis({ von: v!.buchungsdatum, bis: v!.buchungsdatum }));
        expect(blatt.zeilen.filter((z) => z.entryId === v!.buchungId).map((z) => [z.date, z.soll])).toEqual([["2027-01-08", 1_234_00]]);
      }, 60_000);
    }
  }
});
