import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Einnahmen aus revenue.get (#1938) im Abruf. Feldformen wie am echten Konto (November 2026: TYPE incoming_credit, mit
 * Datei und Zahlung); Namen, Nummern und Beträge erfunden.
 */
const API = "https://my.fastbill.com/api/1.0/api.php";
const KEY = "0123456789abcdef0123456789abcdef";
const PDF = new TextEncoder().encode("%PDF-1.4\n% Gutschrift GS-2024-3\n%%EOF\n");

const base = {
  SUBTYPE: "standard",
  IS_CANCELED: "0",
  CURRENCY_CODE: "EUR",
  VAT_CASE: "0",
  CUSTOMER_ID: "601",
  ORGANIZATION: "Plattform Beispiel GmbH",
  PAID_DATE: "2024-04-10 00:00:00",
  SUB_TOTAL: 200,
  VAT_TOTAL: 38,
  TOTAL: 238,
  VAT_ITEMS: [{ VAT_PERCENT: 19, COMPLETE_NET: 200, VAT_VALUE: 38 }],
  PAYMENTS: [{ PAYMENT_ID: "9901", DATE: "10.04.2024", AMOUNT: "238.00", CURRENCY_CODE: "EUR", NOTE: "", TYPE: "Bank" }],
  BANK_IBAN: "DE02120300000000202051",
};
const INVOICE = {
  ...base,
  INVOICE_ID: "7101",
  TYPE: "outgoing",
  STATE: "paid",
  INVOICE_NUMBER: "2024-1",
  INVOICE_DATE: "2024-03-01",
  DOCUMENT_URL: "https://my.fastbill.com/download/datei-7101",
};
const REVENUES = [
  {
    ...base,
    INVOICE_ID: "9101",
    TYPE: "incoming_credit",
    INVOICE_NUMBER: "GS-2024-3",
    INVOICE_DATE: "2024-03-31",
    DOCUMENT_URL: "https://my.fastbill.com/download/datei-9101",
  },
  // FastBill liefert die Datei der API nicht (leere Seite): nicht ohne Beleg archivieren
  {
    ...base,
    INVOICE_ID: "9102",
    TYPE: "incoming_credit",
    INVOICE_NUMBER: "GS-2024-4",
    INVOICE_DATE: "2024-04-30",
    DOCUMENT_URL: "https://my.fastbill.com/download/leer-9102",
  },
  // Eine Art, die am echten Konto nicht vorkam
  {
    ...base,
    INVOICE_ID: "9103",
    TYPE: "other_income",
    INVOICE_NUMBER: "E-1",
    INVOICE_DATE: "2024-05-02",
    DOCUMENT_URL: "https://my.fastbill.com/download/datei-9103",
  },
  // Dieselbe ID wie eine Rechnung aus invoice.get: nur einmal im Archiv
  { ...INVOICE, TYPE: "incoming_credit" },
];

function fakeFastbill(services: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== API) {
      if (url.includes("/datei-")) return new Response(PDF, { headers: { "content-type": "application/pdf" } });
      return new Response("", { headers: { "content-type": "text/html; charset=UTF-8" } });
    }
    const body = JSON.parse(String(init?.body)) as { SERVICE: string; FILTER: Record<string, string>; OFFSET: number };
    services.push(body.SERVICE);
    const page = (key: string, items: unknown[]) => new Response(JSON.stringify({ RESPONSE: { [key]: body.OFFSET === 0 ? items : [] } }));
    if (body.SERVICE === "customer.get") return page("CUSTOMERS", [{ CUSTOMER_ID: "601", ORGANIZATION: "Plattform Beispiel GmbH", COUNTRY_CODE: "DE" }]);
    if (body.SERVICE === "invoice.get") return page("INVOICES", body.FILTER.TYPE === "outgoing" ? [INVOICE] : []);
    if (body.SERVICE === "revenue.get") return page("REVENUES", REVENUES);
    return page("ITEMS", []);
  }) as typeof fetch;
}

describe.skipIf(!testDatabaseUrl)("Einnahmen aus FastBill (Postgres, #1938)", () => {
  let sql: postgres.Sql;
  let fastbill: typeof import("./fastbill.ts");
  let services: string[];
  const actor = "test-user";

  beforeAll(async () => {
    sql = await setupTestDb();
    fastbill = await import("./fastbill.ts");
    const importPkg = await import("@haben/import");
    fastbill.setFastbillClientFactory(
      (o) => new importPkg.FastbillClient({ ...o, fetch: fakeFastbill(services), minIntervalMs: 0, maxRetries: 0, sleep: async () => {} }),
    );
    services = [];
    await fastbill.saveFastbillKey(actor, { email: "inhaber@example.de", apiKey: KEY, callsPerHour: 50 });
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  const vouchers = () => sql`
    select v.lexoffice_id, v.type, v.direction, v.status, v.gross, c.fastbill_id as contact, v.raw ? 'BANK_IBAN' as bank,
      v.raw ? 'DOCUMENT_URL' as url, (select count(*)::int from lexoffice_voucher_files f where f.voucher_id = v.id) as files
    from lexoffice_vouchers v left join contacts c on c.id = v.contact_id
    where v.source = 'fastbill' order by v.lexoffice_id`;

  it("übernimmt eine Einnahme mit Datei als Einnahmebeleg; ohne Datei oder unbekannte Art nicht, mit Meldung", async () => {
    services.length = 0;
    await fastbill.startFastbillImport(actor, { wait: true });
    expect(services).toContain("revenue.get");
    const run = await fastbill.latestFastbillImport();
    expect(run).toMatchObject({ status: "fertig" });
    expect(run!.progress.failed.map((f) => [f.lexofficeId, f.number])).toEqual([
      ["fastbill/revenue/9103", "E-1"],
      ["fastbill/revenue/9102", "GS-2024-4"],
    ]);
    expect(run!.progress.failed[0]!.message).toContain("other_income");
    expect(run!.progress.failed[1]!.message).toContain("Datei");

    expect((await vouchers()).map((v) => ({ ...v }))).toEqual([
      {
        lexoffice_id: "fastbill/invoice/7101",
        type: "invoice",
        direction: "einnahme",
        status: "paid",
        gross: 23_800,
        contact: "601",
        bank: false,
        url: false,
        files: 1,
      },
      {
        lexoffice_id: "fastbill/revenue/9101",
        type: "salesinvoice",
        direction: "einnahme",
        status: "paid",
        gross: 23_800,
        contact: "601",
        bank: false,
        url: false,
        files: 1,
      },
    ]);
    const [einnahme] = await sql`select payment from lexoffice_vouchers where lexoffice_id = 'fastbill/revenue/9101'`;
    expect(einnahme!.payment).toMatchObject({ status: "balanced", items: [{ type: "payment", date: "2024-04-10", amount: 23_800 }] });

    // Der Abgleich je Jahr zählt die Einnahme mit der Rechnung zusammen
    const { reconciliation } = await import("./umzug-abgleich.ts");
    const year = (await reconciliation()).years.find((y: { year: number }) => y.year === 2024) as { einnahmen: unknown } | undefined;
    expect(year?.einnahmen).toEqual({ count: 2, net: 40_000, tax: 7_600, gross: 47_600 });
  });

  it("ein zweiter Abruf überspringt die übernommene Einnahme und versucht die ohne Datei erneut", async () => {
    await fastbill.startFastbillImport(actor, { wait: true });
    const run = await fastbill.latestFastbillImport();
    expect(run!.progress).toMatchObject({ imported: 0, skipped: 2 });
    expect(run!.progress.failed.map((f) => f.lexofficeId)).toEqual(["fastbill/revenue/9103", "fastbill/revenue/9102"]);
    expect(await vouchers()).toHaveLength(2);
  });
});
