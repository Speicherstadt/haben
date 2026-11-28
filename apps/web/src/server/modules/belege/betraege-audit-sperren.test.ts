import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";

// Keine KI-Auslesung im Test
vi.mock("./extraction.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./extraction.ts")>()),
  extractionAvailable: () => false,
}));

/*
 * Reihenfolge der Sperren beim Speichern eines Belegs (#1978): Mit dem Audit-Trigger auf document_amounts holt das Speichern
 * die Sperre der Hash-Kette schon beim Ersetzen der Beträge. Danach darf es keine Zeile mehr sperren müssen, die eine andere
 * Transaktion hält, die ihrerseits gleich auf die Kette wartet (eigenes Konto umbenennen), sonst bricht eine der beiden mit
 * einem Deadlock ab. Erfundene Daten.
 */
describe.skipIf(!testDatabaseUrl)("Beleg speichern und eigenes Konto ändern gleichzeitig (Postgres, #1978)", () => {
  let sql: postgres.Sql;
  let andere: postgres.Sql;
  let documents: typeof import("./documents.ts");
  let konten: typeof import("../eigene-konten/index.ts");
  const actor = "test-user";

  beforeAll(async () => {
    sql = await setupTestDb();
    andere = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    documents = await import("./documents.ts");
    konten = await import("../eigene-konten/index.ts");
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, versteuerung, kontenrahmen)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'BY', 'ist', 'SKR03')`;
  }, 30_000);

  afterAll(async () => {
    await andere?.end();
    await sql?.end();
  });

  async function warteAufSperre(sperrenderPid: number) {
    for (let versuch = 0; versuch < 250; versuch++) {
      const [wartend] = await sql<{ pid: number }[]>`select pid from pg_stat_activity where ${sperrenderPid} = any(pg_blocking_pids(pid))`;
      if (wartend) return wartend.pid;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Die erwartete Sperrwartezeit auf Prozess ${sperrenderPid} ist ausgeblieben.`);
  }

  type Wahl = { ownAccountId: string | null; splits?: unknown[] };
  const eingabe = ({ ownAccountId, splits = [] }: Wahl) =>
    ({
      supplierName: "Softwarehaus Süd",
      supplierUstId: "",
      invoiceNumber: "SH-1",
      documentDate: "2026-09-15",
      dueDate: null,
      category: "software",
      ownAccountId,
      payment: "bank",
      note: "",
      privateShare: 0,
      reverseCharge: null,
      currency: "EUR",
      exchangeRate: null,
      amounts: [{ taxRate: 1900, net: 10_000, tax: 1_900 }],
      splits,
    }) as never;

  const faelle: [string, string, (konto: string) => Wahl][] = [
    ["am Beleg", "4999", (konto) => ({ ownAccountId: konto })],
    [
      "in einer Zeile der Aufteilung",
      "4998",
      (konto) => ({
        ownAccountId: null,
        splits: [
          { category: "software", ownAccountId: konto, taxRate: 1900, net: 6_000 },
          { category: "buero", ownAccountId: null, taxRate: 1900, net: 4_000 },
        ],
      }),
    ],
  ];
  for (const [wo, nummer, wahl] of faelle) {
    it(`eigenes Konto ${wo} wählen, während es jemand umbenennt: beide Transaktionen kommen durch`, async () => {
      const konto = await konten.createOwnAccount(actor, { account: nummer, name: "Software: Entwicklung", parentCategory: "software" });
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, Number(nummer) % 256, 1, 2, 3, 0xff, 0xd9]);
      const { id } = await documents.uploadDocument(actor, { bytes, filename: `software-${nummer}.jpg` });
      await documents.updateDocument(actor, id, eingabe({ ownAccountId: null }));

      let speichern: Promise<unknown> | undefined;
      const umbenennen = andere
        .begin(async (tx) => {
          await tx`select set_config('haben.actor', 'test:andere', true)`;
          const [backend] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          // Wie renameOwnAccount: erst die Zeile sperren, dann ändern (Audit-Eintrag, also Sperre der Kette)
          await tx`select id from own_accounts where id = ${konto} for update`;
          speichern = documents.updateDocument(actor, id, eingabe(wahl(konto))).then(
            () => "gespeichert",
            (e: unknown) => e,
          );
          await warteAufSperre(backend!.pid);
          await tx`update own_accounts set name = 'Software: Lizenzen', updated_at = now() where id = ${konto}`;
        })
        .then(
          () => "umbenannt",
          (e: unknown) => e,
        );

      expect(await umbenennen).toBe("umbenannt");
      expect(await speichern).toBe("gespeichert");
      const [verwendet] = await sql<{ n: number }[]>`
        select (select count(*) from documents where id = ${id} and own_account_id = ${konto})
             + (select count(*) from document_splits where document_id = ${id} and own_account_id = ${konto}) as n`;
      expect(Number(verwendet!.n)).toBe(1);
    }, 30_000);
  }
});
