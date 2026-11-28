import { readFileSync } from "node:fs";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PayPalClient } from "@haben/import";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { alsPayPal } from "./test-verbindung.ts";

/*
 * Der Aktivitätenexport (CSV) kam vor dem Abruf (#1512, #306). Ein abweichender Zweck kann dieselbe Zahlung meinen.
 * Beide Zeilen bleiben für die Dublettenprüfung erhalten. Ein weiterer Abruf erkennt die bereits gespeicherte API-Zeile.
 *
 * Die PayPal-API ist nachgebaut: Der echte `PayPalClient` läuft gegen eine `fetch`-Attrappe, die Anmeldung, Saldo und
 * Transaktionen (nach Zeitraum und Seite geschnitten) aus packages/import/test-fixtures/paypal liefert. Kennungen, Namen und
 * Beträge sind erfunden; es sind keine echten Antworten von PayPal.
 */

type Money = { currency_code: string; value: string };
type Row = {
  transaction_info: {
    transaction_id: string;
    transaction_event_code: string;
    transaction_initiation_date: string;
    transaction_amount: Money;
    fee_amount?: Money;
    transaction_status: string;
    transaction_subject?: string;
    invoice_id?: string;
  };
  payer_info?: { payer_name?: { full_name?: string } };
};
const fixture = JSON.parse(readFileSync(new URL("../../../../../../packages/import/test-fixtures/paypal/transaktionen.json", import.meta.url), "utf8")) as {
  transaction_details: Row[];
};
const ID = "AaBbCcDdEeFf1234clientid";
const SECRET = "EsEcRetSecretWertGeheim5678";
const HEUTE = new Date("2026-11-07T10:00:00Z");

const rows: Row[] = fixture.transaction_details;

const iso = (s: string) => Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
const fetchAttrappe = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname === "/v1/oauth2/token") return Response.json({ access_token: "token", expires_in: 3600 });
  if (url.pathname === "/v1/reporting/balances") return Response.json({ account_id: "BEISPIELHAENDLER1" });
  const from = Date.parse(url.searchParams.get("start_date")!);
  const to = Date.parse(url.searchParams.get("end_date")!);
  const size = Number(url.searchParams.get("page_size"));
  const page = Number(url.searchParams.get("page"));
  const inWindow = rows.filter((r) => iso(r.transaction_info.transaction_initiation_date) >= from && iso(r.transaction_info.transaction_initiation_date) <= to);
  return Response.json({
    transaction_details: inWindow.slice((page - 1) * size, page * size),
    page,
    total_pages: Math.max(1, Math.ceil(inWindow.length / size)),
  });
}) as typeof fetch;

const factory = (options: ConstructorParameters<typeof PayPalClient>[0]) =>
  new PayPalClient({ ...options, fetch: fetchAttrappe, now: () => HEUTE.getTime(), sleep: async () => {} });

/** Aktivitätenexport mit englischen Spalten und teilweise übersetzten Transaktionsarten */
function csv(auszug: Row[] = rows): Uint8Array {
  const art: Record<string, string> = {
    T0006: "Express-Checkout-Zahlung",
    T1107: "Payment refund",
    T0400: "General withdrawal - bank account",
    T1106: "Payment reversal",
    T0001: "Massenzahlung",
  };
  const euro = (v: string) => Number(v).toFixed(2);
  const lines = auszug
    .filter((r) => {
      const i = r.transaction_info;
      return i.transaction_status !== "P" && i.transaction_status !== "D" && i.transaction_amount.currency_code === "EUR";
    })
    .map((r) => {
      const i = r.transaction_info;
      const when = new Date(iso(i.transaction_initiation_date));
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(when);
      const fee = i.fee_amount?.value ?? "0";
      const net = (Number(i.transaction_amount.value) + Number(fee)).toFixed(2);
      return [
        day,
        "10:00:00",
        "CEST",
        r.payer_info?.payer_name?.full_name ?? "",
        art[i.transaction_event_code],
        "Completed",
        "EUR",
        euro(i.transaction_amount.value),
        euro(fee),
        net,
        i.transaction_id,
        i.invoice_id ?? "",
        i.transaction_subject ?? "",
      ]
        .map((x) => `"${x}"`)
        .join(",");
    });
  return new TextEncoder().encode(
    ['"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","Transaction ID","Invoice Number","Subject"', ...lines].join("\n"),
  );
}

describe.skipIf(!testDatabaseUrl)("PayPal-Abruf nach dem CSV-Export (Postgres)", () => {
  let paypal: ReturnType<typeof alsPayPal>;
  let bank: typeof import("../bank/index.ts");
  let sql: postgres.Sql;
  const actor = "test-user";

  beforeAll(async () => {
    sql = await setupTestDb();
    paypal = alsPayPal(await import("./index.ts"));
    bank = await import("../bank/index.ts");
    paypal.setPayPalClientFactory(factory);
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
  });

  it("behält einen anderssprachigen CSV-Umsatz und seinen API-Treffer zur Dublettenprüfung", async () => {
    await paypal.savePayPalConnection(actor, { clientId: ID, clientSecret: SECRET, fetchFrom: "2026-10-01" });
    await sql`insert into bank_accounts (name, purpose, provider, ledger_index) values ('PayPal', 'zahlungsdienstleister', 'paypal', 3)`;
    const konto = (await sql`select id from bank_accounts where provider = 'paypal'`)[0]!.id as string;
    const ersteZahlung = rows.filter((row) => row.transaction_info.transaction_id === "9XY12345AB678901C");
    const ersterImport = await bank.importStatement(actor, { bytes: csv(ersteZahlung), filename: "erster-tag.csv" }, konto);
    expect(ersterImport.added).toBe(2);
    const ersterAbruf = await paypal.syncPayPal(actor, new Date("2026-10-06T12:00:00Z"));
    expect(ersterAbruf.error).toBeNull();
    const ref = "9XY12345AB678901C";
    async function pruefstand() {
      const umsaetze = await sql`select i.format from bank_transactions t join bank_imports i on i.id = t.import_id
        where t.bank_account_id = ${konto} and t.bank_reference = ${ref} order by i.format`;
      expect(umsaetze.map((row) => row.format)).toEqual(["paypal-api", "paypal-csv"]);
      const pruefung = await sql`select r.decision from bank_duplicate_reviews r
        join bank_transactions neu on neu.id = r.transaction_id
        join bank_transactions alt on alt.id = r.original_transaction_id
        where neu.bank_account_id = ${konto} and neu.bank_reference = ${ref} and alt.bank_reference = ${ref}`;
      expect(pruefung).toEqual([{ decision: "pending" }]);
    }
    await pruefstand();
    const nochmal = await paypal.syncPayPal(actor, new Date("2026-10-07T12:00:00Z"));
    expect(nochmal.error).toBeNull();
    expect(nochmal.added).toBe(0);
    await pruefstand();
    // Nach der Quellenbindung kommt ein weiterer Export, bevor der nächste Abruf diese Tage sieht.
    const csvImport = await bank.importStatement(actor, { bytes: csv(), filename: "aktivitaeten.csv" }, konto);
    expect(csvImport.added).toBe(10);
    const result = await paypal.syncPayPal(actor, HEUTE);
    expect(result.error).toBeNull();
    const unbekannt = await sql`select i.format from bank_transactions t join bank_imports i on i.id = t.import_id
      where t.bank_account_id = ${konto} and t.bank_reference = '2ML89012HJ345678K' order by i.format`;
    expect(unbekannt.map((row) => row.format)).toEqual(["paypal-api", "paypal-csv"]);
    // Der Abruf erkennt seine elf identifizierten Bewegungen bei der Wiederholung wieder.
    expect((await sql`select count(*)::int as n from import_movements`)[0]!.n).toBe(11);
    const vorher = (await sql`select count(*)::int as n from bank_transactions`)[0]!.n;
    const erneut = await paypal.syncPayPal(actor, HEUTE);
    expect(erneut.error).toBeNull();
    expect(erneut.added).toBe(0);
    expect((await sql`select count(*)::int as n from bank_transactions`)[0]!.n).toBe(vorher);
  });

  it("schlägt auch die Rückzahlung mit zweitem Ereigniscode derselben PayPal-ID vor", async () => {
    const ref = "2TW91234YZ567890A";
    const zahlung = structuredClone(rows[0]!);
    zahlung.transaction_info.transaction_id = ref;
    zahlung.transaction_info.transaction_initiation_date = "2026-11-07T08:00:00+0000";
    const rueckzahlung = structuredClone(zahlung);
    rueckzahlung.transaction_info.transaction_event_code = "T1107";
    rueckzahlung.transaction_info.transaction_amount.value = "-50.00";
    delete rueckzahlung.transaction_info.fee_amount;
    rows.push(zahlung, rueckzahlung);
    const [konto] = await sql`select id from bank_accounts where provider = 'paypal'`;
    await bank.importStatement(actor, { bytes: csv([zahlung, rueckzahlung]), filename: "zahlung-und-rueckzahlung.csv" }, konto!.id);
    const abruf = await paypal.syncPayPal(actor, new Date("2026-11-08T12:00:00Z"));
    expect(abruf.error).toBeNull();
    const paare = await sql`select r.decision from bank_duplicate_reviews r
      join bank_transactions neu on neu.id = r.transaction_id
      join bank_transactions alt on alt.id = r.original_transaction_id
      where neu.bank_reference = ${`${ref}/T1107`} and alt.bank_reference = ${ref} and alt.amount = -5000`;
    expect(paare).toEqual([{ decision: "pending" }]);
  });
});
