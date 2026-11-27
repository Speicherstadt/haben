import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Privatentnahme als Zeile einer Aufteilung (#1975) in allen Kombinationen von Teilabzug (§ 15 Abs. 4 UStG), § 13b,
 * Gutschrift und Ist/Soll. Vergleich: derselbe Beleg ohne Aufteilung mit 25 % Privatanteil am Beleg. 100,00 € netto,
 * 19,00 € Steuer, davon 25,00 € netto privat: Beide Wege ergeben gerundet dieselbe Entnahme (25,00 € netto, 4,75 €
 * Steuer). Journal, Voranmeldung, Nebenbücher und EÜR müssen deshalb in beiden Fällen dieselben Zahlen tragen, auch
 * nach einer Teilzahlung und über zwei Monate.
 */

function dkbCsv(rows: string[][]) {
  const header = `"Girokonto";"DE12 1203 0000 1234 5678 90"\n""\n`;
  const columns = `"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"\n`;
  return new TextEncoder().encode(`${header + columns + rows.map((r) => r.map((c) => `"${c}"`).join(";")).join("\n")}\n`);
}

const euro = (cents: number) => `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)},${String(Math.abs(cents) % 100).padStart(2, "0")}`;

type Fall = {
  kontenrahmen: "SKR03" | "SKR04";
  versteuerung: "ist" | "soll";
  rc: "eu" | null;
  anteil: number | null;
  gutschrift: boolean;
  erstattet?: boolean;
  spaeter?: boolean;
  /** Kleinunternehmer: kein Vorsteuerabzug, § 13b schuldet er trotzdem */
  klein?: boolean;
};

describe.skipIf(!testDatabaseUrl)("Privatentnahme in allen Kombinationen (Postgres)", () => {
  let documents: typeof import("./documents.ts");
  let vat: typeof import("../umsatzsteuer/vat-figures.ts");
  let reports: typeof import("../auswertungen/reports.ts");
  let abgleich: typeof import("../auswertungen/abgleich.ts");
  let bank: typeof import("../bank/index.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  let fileSeq = 0;

  beforeAll(async () => {
    sql = await setupTestDb();
    documents = await import("./documents.ts");
    vat = await import("../umsatzsteuer/vat-figures.ts");
    reports = await import("../auswertungen/reports.ts");
    abgleich = await import("../auswertungen/abgleich.ts");
    bank = await import("../bank/index.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function reset(f: Fall) {
    await leeren(sql)`truncate document_cancellations, vat_returns, write_offs, allocations, bank_transactions, bank_imports, bank_accounts, cash_entries,
      asset_depreciations, assets, journal_lines, journal_entries, document_splits, document_amounts, documents, year_closings, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, versteuerung, kontenrahmen, kleinunternehmer, rechtsform)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'BY', ${f.versteuerung}, ${f.kontenrahmen}, ${f.klein ?? false}, 'einzelunternehmen')`;
  }

  async function beleg(f: Fall, mitAufteilung: boolean) {
    fileSeq++;
    const s = f.gutschrift ? -1 : 1;
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, fileSeq % 256, Math.floor(fileSeq / 256), 73]);
    const { id } = await documents.uploadDocument(actor, {
      bytes,
      filename: `kombi-${fileSeq}.jpg`,
    });
    await documents.updateDocument(actor, id, {
      supplierName: "Telekom Deutschland GmbH",
      supplierUstId: "",
      invoiceNumber: `K-${fileSeq}`,
      documentDate: "2026-09-15",
      dueDate: null,
      ...(f.spaeter ? { serviceFrom: "2026-10-01", serviceTo: "2026-10-31" } : {}),
      category: mitAufteilung ? "sonstiges" : "telefon",
      payment: "bank",
      note: "",
      privateShare: mitAufteilung ? 0 : 25,
      reverseCharge: f.rc,
      currency: "EUR",
      exchangeRate: null,
      erstattetBezahltes: f.erstattet ?? false,
      vorsteuerAnteil: f.anteil,
      amounts: [{ taxRate: 1900, net: s * 10_000, tax: s * 1_900 }],
      splits: mitAufteilung
        ? [
            { category: "telefon", taxRate: 1900, net: s * 7_500 },
            { category: "privatentnahme", taxRate: 1900, net: s * 2_500 },
          ]
        : [],
    } as Parameters<typeof documents.updateDocument>[2]);
    return id;
  }

  async function zahlung(documentId: string, datum: string, cents: number) {
    await bank.importStatement(
      actor,
      {
        bytes: dkbCsv([
          [
            datum,
            datum,
            "Gebucht",
            "Testfirma",
            "Telekom",
            `TK ${fileSeq}`,
            cents < 0 ? "Ausgang" : "Eingang",
            "DE02100100100006820101",
            euro(cents),
            "",
            "",
            "",
          ],
        ]),
        filename: `konto-${fileSeq}-${datum}.csv`,
      },
      null,
    );
    const [t] = await sql`select id, amount from bank_transactions where booking_date = ${datum.replace(/(\d\d)\.(\d\d)\.(\d\d)/, "20$3-$2-$1")}`;
    await bank.allocate(actor, {
      kind: "document",
      transactionId: t!.id as string,
      documentId,
      amount: t!.amount as number,
    });
  }

  async function stand() {
    const salden =
      await sql`select l.account, sum(l.debit - l.credit)::int as saldo from journal_lines l group by l.account having sum(l.debit - l.credit) <> 0 order by l.account`;
    const monate: Record<string, unknown> = {};
    for (const month of [9, 10]) {
      const v = await vat.computeVatFigures({ year: 2026, month });
      monate[month] = {
        kz66: v.kz66,
        kz67: v.kz67,
        kz46: v.kz46,
        kz47: v.kz47,
        erlaeuterung66: v.inputTax.reduce((sum, z) => sum + z.tax, 0),
        erlaeuterungBasis: v.inputTax.reduce((sum, z) => sum + z.base, 0),
      };
    }
    const euer = await reports.euerForYear(2026);
    const ausgaben = Object.fromEntries(euer.ausgaben.filter((l) => l.amount !== 0).map((l) => [l.key, l.amount]));
    const einnahmen = Object.fromEntries(euer.einnahmen.filter((l) => l.amount !== 0).map((l) => [l.key, l.amount]));
    return {
      salden: Object.fromEntries(salden.map((r) => [r.account, r.saldo])),
      monate,
      ausgaben,
      einnahmen,
    };
  }

  async function abweichungen() {
    const vatDiff = [];
    for (const month of [9, 10]) vatDiff.push(...(await abgleich.vatAbgleich({ year: 2026, month })).zeilen.filter((z) => z.journal !== z.quelle));
    const euerDiff = (await abgleich.euerAbgleich(2026)).zeilen.filter((z) => z.journal !== z.quelle);
    return { vat: vatDiff, euer: euerDiff };
  }

  async function durchlauf(f: Fall, mitAufteilung: boolean) {
    await reset(f);
    const id = await beleg(f, mitAufteilung);
    const saved = (await documents.getDocument(id))!;
    expect(documents.bookingIssues(saved.document, saved.amounts, "2026-09-20", saved.splits)).toEqual([]);
    await documents.bookDocument(actor, id);
    const s = f.gutschrift ? 1 : -1;
    const gross = f.rc ? 10_000 : 11_900;
    const gebucht = await stand();
    await zahlung(id, "20.09.26", s * 4_000);
    const teilweise = await stand();
    const teilDiff = await abweichungen();
    await zahlung(id, "20.10.26", s * (gross - 4_000));
    const bezahlt = await stand();
    const diff = await abweichungen();
    return { gebucht, teilweise, bezahlt, teilDiff, diff };
  }

  const faelle: Fall[] = [];
  for (const rc of [null, "eu"] as const) faelle.push({ kontenrahmen: "SKR03", versteuerung: "ist", rc, anteil: null, gutschrift: false, klein: true });
  for (const kontenrahmen of ["SKR03", "SKR04"] as const)
    for (const versteuerung of ["ist", "soll"] as const)
      for (const rc of [null, "eu"] as const)
        for (const anteil of [null, 5_000])
          for (const gutschrift of [false, true])
            faelle.push({
              kontenrahmen,
              versteuerung,
              rc,
              anteil,
              gutschrift,
            });
  faelle.push({
    kontenrahmen: "SKR03",
    versteuerung: "ist",
    rc: null,
    anteil: null,
    gutschrift: true,
    erstattet: true,
  });
  faelle.push({
    kontenrahmen: "SKR04",
    versteuerung: "soll",
    rc: null,
    anteil: 5_000,
    gutschrift: true,
    erstattet: true,
  });
  faelle.push({
    kontenrahmen: "SKR03",
    versteuerung: "ist",
    rc: null,
    anteil: null,
    gutschrift: false,
    spaeter: true,
  });
  faelle.push({
    kontenrahmen: "SKR04",
    versteuerung: "soll",
    rc: null,
    anteil: 5_000,
    gutschrift: false,
    spaeter: true,
  });

  it.each(faelle)(
    "$kontenrahmen $versteuerung rc=$rc anteil=$anteil gutschrift=$gutschrift erstattet=$erstattet spaeter=$spaeter klein=$klein: Aufteilung mit Entnahme wie 25 % Privatanteil am Beleg",
    async (f) => {
      const privatanteil = await durchlauf(f, false);
      const aufteilung = await durchlauf(f, true);
      expect(aufteilung.diff, "Abgleich Journal ↔ Quelle mit Entnahmezeile").toEqual({ vat: [], euer: [] });
      expect(aufteilung.teilDiff, "Abgleich nach Teilzahlung mit Entnahmezeile").toEqual({ vat: [], euer: [] });
      expect({
        gebucht: aufteilung.gebucht,
        teilweise: aufteilung.teilweise,
        bezahlt: aufteilung.bezahlt,
      }).toEqual({
        gebucht: privatanteil.gebucht,
        teilweise: privatanteil.teilweise,
        bezahlt: privatanteil.bezahlt,
      });
    },
  );

  it("Ist, voller Abzug, drei Raten: die EÜR rundet kumuliert wie beim Privatanteil am Beleg", async () => {
    // Je Rate einzeln gerundet ergäben drei Raten zusammen einen Cent mehr oder weniger als die Vollzahlung
    const f: Fall = { kontenrahmen: "SKR03", versteuerung: "ist", rc: null, anteil: null, gutschrift: false };
    const raten = async (mitAufteilung: boolean) => {
      await reset(f);
      const id = await beleg(f, mitAufteilung);
      await documents.bookDocument(actor, id);
      await zahlung(id, "20.09.26", -3_966);
      await zahlung(id, "21.09.26", -3_967);
      await zahlung(id, "22.09.26", -3_967);
      return { stand: await stand(), diff: await abweichungen() };
    };
    const privatanteil = await raten(false);
    const aufteilung = await raten(true);
    expect(aufteilung.diff).toEqual({ vat: [], euer: [] });
    expect(aufteilung.stand).toEqual(privatanteil.stand);
  });
});
