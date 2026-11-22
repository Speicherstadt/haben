import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";

const gates = vi.hoisted(() => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  return { ready: deferred(), release: deferred() };
});
vi.mock("./archive.ts", async (original) => {
  const actual = await original<typeof import("./archive.ts")>();
  return {
    ...actual,
    async addArchiveFile(...args: Parameters<typeof actual.addArchiveFile>) {
      if (args[1].filename === "wiso-test.csv") {
        gates.ready.resolve();
        await gates.release.promise;
      }
      return actual.addArchiveFile(...args);
    },
  };
});
vi.mock("@haben/import", async (original) => ({
  ...(await original<typeof import("@haben/import")>()),
  previewBuchhaltungsbutlerExport: () => ({
    year: 2026,
    dateFrom: null,
    dateTo: null,
    bookings: 0,
    vouchers: [],
    files: 0,
    withoutReceipt: 0,
    multipleFiles: 0,
    warnings: [],
  }),
}));

const HEADER =
  "Buchungsnummer;Teilbuchung;Zahlungsdatum;Wertstellungsdatum;Buchungstext;Konto;Kontobezeichnung;Gegenkonto;Gegenkontobezeichnung;Soll;Haben;Steuerschluessel;Steuersatz;Steuerschluesselbezeichnung;Belegnummer;Buchungsdatum;UStID;Umsatzart";
const data = new TextEncoder().encode(
  HEADER + "\r\n" + "1;1;01.01.2026;01.01.2026;Testbuchung;4600;Werbekosten;1200;Bank;67,92;0,00;VSt 19 %;19,00;Vorsteuer 19 %;N1;01.01.2026;;0",
);

describe.skipIf(!testDatabaseUrl)("Abrufsperre beim Umzug (Postgres)", () => {
  let sql: postgres.Sql;
  beforeAll(async () => {
    sql = await setupTestDb();
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, kontenrahmen, versteuerung, rechtsform)
      values (1, 'Musterfirma', 'Musterweg 1', '28217', 'Bremen', 'rechnung@example.com', '60/145/12345', 'HB', 'SKR03', 'ist', 'einzelunternehmen')`;
  }, 90_000);
  afterAll(async () => {
    await sql?.end();
  });
  it("ein langsamer WISO-Import wird vom BuchhaltungsButler-Start nicht abgebrochen", async () => {
    const { startWisoImport } = await import("./wiso.ts");
    const { startBuchhaltungsbutlerImport } = await import("./buchhaltungsbutler.ts");
    const running = startWisoImport("wiso-test", data, "wiso-test.csv");
    try {
      await Promise.race([
        gates.ready.promise,
        running.then(() => {
          throw new Error("Der WISO-Import erreichte die Archivsperre nicht.");
        }),
      ]);
      await sql`update lexoffice_imports set updated_at = now() - interval '4 minutes' where source = 'wiso'`;
      await expect(startBuchhaltungsbutlerImport("bb-test", [])).rejects.toMatchObject({
        cause: { code: "23505", constraint_name: "lexoffice_imports_one_running" },
      });
      expect((await sql`select status from lexoffice_imports where source = 'wiso'`)[0]?.status).toBe("laeuft");
    } finally {
      gates.release.resolve();
      await running;
    }
  }, 15_000);
});
