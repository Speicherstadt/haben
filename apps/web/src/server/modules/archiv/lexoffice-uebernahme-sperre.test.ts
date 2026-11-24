import { readFileSync } from "node:fs";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * #1624: Ein offener Eingangsbeleg aus Lexoffice mit zwei Anhängen, von denen nur einer ankommt. Der fehlende steht auf
 * „Abruf fehlgeschlagen“. Weil eine Datei da ist, griff die Sperre der Übernahme nicht, die nur ohne jede Datei auf den
 * Dateistand schaut. Unvollständig Abgerufenes übernimmt Haben nicht ohne Rückfrage (Konventionen, „Umzüge“); auf `main`
 * kam ein solcher Beleg gar nicht erst ins Archiv.
 */

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../../../../../../packages/import/test-fixtures/lexoffice/${name}`, import.meta.url), "utf8"));

const VOUCHER = fixture("voucher-gross.json");
const ANHANG_A = "5a1d2b6e-3c4f-4e5a-9b8c-7d6e5f4a3b2c";
const ANHANG_B = "6b2e3c7f-4d5a-4f6b-8c9d-8e7f6a5b4c3d";
const PDF = new TextEncoder().encode("%PDF-1.4\n% Beleg 2023-4711\n%%EOF\n");
const BILD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function page(content: unknown[]) {
  return { content, first: true, last: true, totalPages: 1, totalElements: content.length, number: 0, size: 250, numberOfElements: content.length };
}

const listItem = {
  id: String(VOUCHER.id),
  voucherType: "purchaseinvoice",
  voucherStatus: "open",
  voucherNumber: "2023-4711",
  voucherDate: "2023-02-21T00:00:00.000+01:00",
  createdDate: "2023-02-21T14:43:28.000+01:00",
  updatedDate: "2023-02-21T14:45:01.000+01:00",
  contactName: "Berliner Kindl GmbH",
  totalAmount: 100,
  openAmount: 100,
  currency: "EUR",
  archived: false,
};

/** Steuert, ob der Abruf den zweiten Anhang herausgibt; der erste Lauf liefert nur den ersten */
let zweiterAnhang = false;

/** Nachgebaute Lexware-API: ein offener Eingangsbeleg mit zwei Anhängen, der zweite schlägt zunächst fehl */
function fakeApi() {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, "");
    if (new Headers(init?.headers).get("authorization") !== "Bearer schluessel-1234567890-abcdefghij") return json({ message: "Unauthorized" }, 401);
    if (path === "/profile") return json(fixture("profile.json"));
    if (path === "/posting-categories") return json([]);
    if (path === "/contacts") return json(page([]));
    if (path === "/voucherlist") return json(page(url.searchParams.get("archived") === "true" ? [] : [listItem]));
    if (path === `/vouchers/${VOUCHER.id}`) return json({ ...VOUCHER, voucherStatus: "open", files: [ANHANG_A, ANHANG_B] });
    if (path === `/files/${ANHANG_A}`)
      return new Response(PDF, { headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="Beleg.pdf"' } });
    if (zweiterAnhang && path === `/files/${ANHANG_B}`)
      return new Response(BILD, { headers: { "content-type": "image/jpeg", "content-disposition": 'attachment; filename="Quittung.jpg"' } });
    if (path.startsWith("/files/")) return json({ message: "interner Fehler" }, 500);
    if (path.startsWith("/payments/")) return json({ message: "not found" }, 404);
    return json({ message: `unbekannt ${path}` }, 404);
  }) as typeof fetch;
}

describe.skipIf(!testDatabaseUrl)("Lexoffice: Übernahme gesperrt, solange ein Anhang fehlt (#1624)", () => {
  let lexoffice: typeof import("./lexoffice.ts");
  let legacy: typeof import("./legacy-open.ts");
  const actor = "test-user";
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = await setupTestDb();
    lexoffice = await import("./lexoffice.ts");
    legacy = await import("./legacy-open.ts");
    const importPkg = await import("@haben/import");
    lexoffice.setLexofficeClientFactory(
      (o) => new importPkg.LexofficeClient({ ...o, fetch: fakeApi(), minIntervalMs: 0, maxRetries: 0, sleep: async () => {} }),
    );
    await lexoffice.saveApiKey(actor, "schluessel-1234567890-abcdefghij");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  it("sperrt den offenen Posten, wenn ein Anhang da ist und der andere fehlschlug", async () => {
    await lexoffice.startImport(actor, { wait: true });
    const [beleg] = await sql`select id from lexoffice_vouchers where number = '2023-4711'`;
    const dateien = await sql`select id from lexoffice_voucher_files where voucher_id = ${beleg!.id}`;
    expect(dateien).toHaveLength(1);

    const [posten] = (await legacy.openLegacyItems("2023-12-31")).filter((i) => i.number === "2023-4711");
    expect(posten!.blocker).toBe("Datei erwartet, Abruf aus Lexware Office fehlgeschlagen. Im Umzug „Erneut abrufen“ wählen.");
  });

  it("gibt den Posten frei, wenn ein späterer Lauf den Anhang nachholt", async () => {
    zweiterAnhang = true;
    await lexoffice.startImport(actor, { wait: true });
    const [posten] = (await legacy.openLegacyItems("2023-12-31")).filter((i) => i.number === "2023-4711");
    expect(posten!.blocker).toBeNull();
  });
});
