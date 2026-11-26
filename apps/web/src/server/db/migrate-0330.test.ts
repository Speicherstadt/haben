import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../test-db.ts";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/*
 * Migration 0330 (#1926): document_splits trägt neben dem Privatanteil in Prozent einen absoluten Betrag samt Basis
 * (netto oder brutto). Angelegt werden nur zwei nullable Spalten, kein Tabellenumschreiben; Bestandszeilen behalten ihren
 * Prozentwert und bleiben ohne Betrag. Die CHECKs halten Betrag und Basis zusammen, lassen höchstens eine der beiden
 * Angaben je Zeile zu und keinen negativen Betrag.
 */
describe.skipIf(!testDatabaseUrl)("Migration 0330: Privatbetrag je Zeile (Postgres, #1926)", () => {
  let sql: postgres.Sql;
  let belegId: string;

  beforeAll(async () => {
    const name = decodeURIComponent(new URL(testDatabaseUrl!).pathname.slice(1));
    const admin = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    await admin`drop database if exists ${admin(name)} with (force)`;
    await admin`create database ${admin(name)}`;
    await admin.end();
    const previous = mkdtempSync(join(tmpdir(), "haben-migrationen-"));
    cpSync(MIGRATIONS, previous, { recursive: true });
    const full = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
    const idx = full.entries.findIndex((e: { tag: string }) => e.tag === "0330_messy_kate_bishop");
    writeFileSync(join(previous, "meta", "_journal.json"), JSON.stringify({ ...full, entries: full.entries.slice(0, idx) }));
    sql = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(drizzle(sql), { migrationsFolder: previous });
    // Bestand vor 0330: eine Zeile mit Prozentwert, eine ohne Privatanteil
    const [doc] = await sql<{ id: string }[]>`
      insert into documents (sha256, filename, mime_type, size, net, tax, gross)
      values (${"d".repeat(64)}, 'telekom.pdf', 'application/pdf', 100, 4452, 846, 5298)
      returning id`;
    belegId = doc!.id;
    await sql`insert into document_splits (document_id, position, category, tax_rate, net, tax, private_share)
      values (${belegId}, 1, 'internet', 1900, 3360, 639, 25), (${belegId}, 2, 'telefon', 1900, 1092, 207, 0)`;
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
  });

  /** Zeile mit Privatbetrag; die Prüfungen der Datenbank sollen sie abweisen bzw. annehmen */
  const zeile = (position: number, amount: number | null, basis: string | null, share = 0) => sql`
    insert into document_splits (document_id, position, category, tax_rate, net, tax, private_share, private_amount, private_amount_basis)
    values (${belegId}, ${position}, 'sonstiges', 1900, 1092, 207, ${share}, ${amount}, ${basis})`;

  it("legt die Spalten an und lässt Bestandsdaten mit Prozentwert unberührt", async () => {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });

    expect(
      await sql`select position, private_share, private_amount, private_amount_basis from document_splits
      where document_id = ${belegId} order by position`,
    ).toEqual([
      { position: 1, private_share: 25, private_amount: null, private_amount_basis: null },
      { position: 2, private_share: 0, private_amount: null, private_amount_basis: null },
    ]);
  }, 120_000);

  it("nimmt einen Betrag mit Basis an", async () => {
    await zeile(3, 1_299, "brutto");
    expect(await sql`select private_amount, private_amount_basis from document_splits where document_id = ${belegId} and position = 3`).toEqual([
      { private_amount: 1_299, private_amount_basis: "brutto" },
    ]);
    await sql`delete from document_splits where document_id = ${belegId} and position = 3`;
  });

  it("weist Betrag und Basis ohne einander ab", async () => {
    await expect(zeile(4, 1_299, null)).rejects.toThrow();
    await expect(zeile(5, null, "brutto")).rejects.toThrow();
  });

  it("weist Betrag und Prozentwert zusammen ab", async () => {
    await expect(zeile(6, 1_299, "brutto", 25)).rejects.toThrow();
  });

  it("weist einen negativen Betrag und eine unbekannte Basis ab", async () => {
    await expect(zeile(7, -1, "netto")).rejects.toThrow();
    await expect(zeile(8, 1_299, "netto_ohne_steuer")).rejects.toThrow();
  });
});
