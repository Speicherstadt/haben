import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { problems, rolledBack, tamper } from "../modules/auswertungen/test-anhaengbar.ts";
import { testDatabaseUrl } from "../test-db.ts";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/*
 * Migration „Hashes weggelassener Spalten“ (#2038, 0351): Einträge von vorher haben keine Hashes von PDF und XML. Die Migration trägt sie für jede solche
 * Zeile nachträglich ein, mit Hinweis in der Kette; danach meldet der Abgleich nichts, und eine still getauschte Datei
 * fällt auf.
 */
describe.skipIf(!testDatabaseUrl)("Migration: Hashes von PDF und XML im Bestand (Postgres)", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    const name = decodeURIComponent(new URL(testDatabaseUrl!).pathname.slice(1));
    const admin = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    await admin`drop database if exists ${admin(name)} with (force)`;
    await admin`create database ${admin(name)}`;
    await admin.end();
    const previous = mkdtempSync(join(tmpdir(), "haben-migrationen-"));
    try {
      cpSync(MIGRATIONS, previous, { recursive: true });
      const full = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
      const idx = full.entries.findIndex((e: { tag: string }) => e.tag.endsWith("_hash_weggelassene_spalten"));
      writeFileSync(join(previous, "meta", "_journal.json"), JSON.stringify({ ...full, entries: full.entries.slice(0, idx) }));
      sql = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
      const { drizzle } = await import("drizzle-orm/postgres-js");
      const { migrate } = await import("drizzle-orm/postgres-js/migrator");
      await migrate(drizzle(sql), { migrationsFolder: previous });
    } finally {
      rmSync(previous, { recursive: true, force: true });
    }
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
  });

  const sha256 = (inhalt: string | Buffer) => createHash("sha256").update(inhalt).digest("hex");

  it("trägt die Hashes vorhandener Zeilen nachträglich ein, mit Hinweis, und meldet danach eine getauschte Datei; eine Zeile ohne Eintrag bleibt ein Befund", async () => {
    const pdf = Buffer.from("%PDF-1.7 Protokoll");
    const vorher = await sql.begin(async (tx) => {
      await tx`select set_config('haben.actor', 'test:vorher', true)`;
      const [voranmeldung] = await tx`insert into vat_returns (year, month) values (2025, 12) returning id`;
      const [u] = await tx`insert into vat_return_submissions (vat_return_id, kind, ok, code, message, request_xml, response_xml,
          server_response_xml, protocol_pdf)
        values (${voranmeldung!.id}, 'send', true, 0, 'ok', '<Elster/>', '<Antwort/>', '<Server/>', ${pdf}) returning id`;
      const [konto] = await tx`insert into bank_accounts (name, iban) values ('Giro', 'DE89370400440532013000') returning id`;
      const [s] = await tx`insert into sepa_transfers (bank_account_id, message_id, execution_date, number_of_transactions, control_sum, xml)
        values (${konto!.id}, 'MSG-1', '2026-03-01', 1, 4999, '<Document/>') returning id`;
      // An den Triggern vorbei eingefügt: Der Nachtrag darf sie nicht bezeugen, sie bleibt ein Befund
      await tx`set local session_replication_role = replica`;
      const [still] = await tx`insert into sepa_transfers (bank_account_id, message_id, execution_date, number_of_transactions, control_sum, xml)
        values (${konto!.id}, 'MSG-STILL', '2026-03-01', 1, 4999, '<Document>still</Document>') returning id`;
      return { uebermittlung: u!.id as string, ueberweisung: s!.id as string, still: still!.id as string };
    });
    const nichtImAuditLog = [{ art: "siegel", tabelle: "sepa_transfers", zeile: vorher.still, seq: null, befund: "Zeile steht nicht im Audit-Log" }];
    expect(await problems(sql)).toEqual(nichtImAuditLog);
    // Vor dem Update angehängt, mit eingeschalteten Triggern: ein INSERT-Eintrag mit leeren Hashes. Er darf weder den Nachtrag
    // verhindern noch die Prüfung der Spalten ersetzen (Review zu #2072).
    await sql.begin(async (tx) => {
      await tx`insert into audit_log (actor, table_name, row_id, action, old_value, new_value)
        select 'test', 'vat_return_submissions', ${vorher.uebermittlung}, 'INSERT', null,
               (to_jsonb(u) - 'protocol_pdf' - 'request_xml' - 'response_xml' - 'server_response_xml') || '{"omitted_sha256": {}}'::jsonb
          from vat_return_submissions u where u.id = ${vorher.uebermittlung}`;
    });
    const [kopf] = await sql`select seq from audit_chain`;

    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });

    const nachgetragen = await sql`select table_name, row_id, actor, new_value from audit_log where seq > ${kopf!.seq} order by seq`;
    expect(nachgetragen.map((e) => [e.table_name, e.row_id, e.actor])).toEqual([
      ["sepa_transfers", vorher.ueberweisung, "system:migration"],
      ["vat_return_submissions", vorher.uebermittlung, "system:migration"],
      ["audit_chain", "1", "system:migration"],
    ]);
    expect(nachgetragen[0]!.new_value).toMatchObject({ id: vorher.ueberweisung, omitted_sha256: { xml: sha256("<Document/>") } });
    expect(nachgetragen[1]!.new_value).not.toHaveProperty("protocol_pdf");
    expect(nachgetragen[1]!.new_value).toMatchObject({ omitted_sha256: { protocol_pdf: sha256(pdf), request_xml: sha256("<Elster/>") } });
    expect(nachgetragen[2]!.new_value).toEqual({
      hinweis: expect.stringContaining("nachträglich eingetragen"),
      tabellen: { sepa_transfers: 1, vat_return_submissions: 1 },
    });
    expect(await problems(sql)).toEqual(nichtImAuditLog);

    const befunde = await rolledBack(sql, async (tx) => {
      await tamper(tx, () => tx`update vat_return_submissions set protocol_pdf = ${Buffer.from("%PDF-1.7 anders")} where id = ${vorher.uebermittlung}`);
      return problems(tx);
    });
    expect(befunde).toEqual([
      ...nichtImAuditLog,
      expect.objectContaining({ tabelle: "vat_return_submissions", zeile: vorher.uebermittlung, befund: "Spalte protocol_pdf weicht vom Audit-Log ab" }),
    ]);
  }, 120_000);
});
