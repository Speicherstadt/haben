import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../test-db.ts";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
/** Die Nummer der Migration kann sich bis zum Merge ändern, ihr Name nicht */
const MIGRATION = "_betraege_audit";

const ID = {
  kontakt: "00000000-0000-4000-8000-0000000019c1",
  entwurf: "00000000-0000-4000-8000-0000000019a1",
  rechnung: "00000000-0000-4000-8000-0000000019a2",
  belegEntwurf: "00000000-0000-4000-8000-0000000019d1",
  beleg: "00000000-0000-4000-8000-0000000019d2",
};

/*
 * Audit-Trigger für document_amounts, invoice_lines und invoice_taxes (#1978) auf einer Instanz mit Bestand: Die Migration
 * trägt nichts nach und ändert weder Daten noch Siegel. Entwürfe von vorher stehen erst mit ihrer nächsten Änderung im
 * Audit-Log (UPDATE oder DELETE mit altem Wert, ohne INSERT davor); Festgeschriebenes bleibt gesperrt und versiegelt.
 */
describe.skipIf(!testDatabaseUrl)("Migration: Beträge, Positionen und Steuerzeilen im Audit-Log (Postgres, #1978)", () => {
  let sql: postgres.Sql;
  let eintraegeVorher = 0;

  /** Bestand vor der Migration: je ein Entwurf und je ein festgeschriebener Datensatz, festgeschrieben über die Trigger */
  async function bestand() {
    await sql.begin(async (tx) => {
      await tx`select set_config('haben.actor', 'test:vorher', true)`;
      await tx`insert into company (id, name, versteuerung) values (1, 'Testfirma', 'ist')`;
      await tx`insert into contacts (id, name) values (${ID.kontakt}, 'Kunde A')`;
      for (const id of [ID.entwurf, ID.rechnung]) {
        await tx`insert into invoices (id, contact_id, issue_date, due_date, net, tax, gross)
          values (${id}, ${ID.kontakt}, '2026-03-01', '2026-03-15', 10700, 1970, 12670)`;
        await tx`insert into invoice_lines (invoice_id, position, description, quantity, unit, unit_price, tax_rate, net)
          values (${id}, 1, 'Beratung', 1000, 'C62', 10000, 1900, 10000), (${id}, 2, 'Buch', 1000, 'C62', 700, 700, 700)`;
        await tx`insert into invoice_taxes (invoice_id, rate, base, tax) values (${id}, 1900, 10000, 1900), (${id}, 700, 700, 49)`;
      }
      await tx`update invoices set status = 'final', number = 'RE-2026-0001', number_year = 2026, number_counter = 1, locked_at = now()
        where id = ${ID.rechnung}`;
      for (const [id, sha] of [
        [ID.belegEntwurf, "1"],
        [ID.beleg, "2"],
      ] as const) {
        await tx`insert into documents (id, sha256, filename, mime_type, size, supplier_name, document_date, net, tax, gross)
          values (${id}, ${sha.repeat(64)}, 'beleg.pdf', 'application/pdf', 1234, 'Lieferant B', '2026-03-05', 5000, 950, 5950)`;
        await tx`insert into document_amounts (document_id, tax_rate, net, tax) values (${id}, 1900, 5000, 950)`;
      }
      await tx`update documents set status = 'gebucht', locked_at = now() where id = ${ID.beleg}`;
    });
  }

  beforeAll(async () => {
    const name = decodeURIComponent(new URL(testDatabaseUrl!).pathname.slice(1));
    const admin = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    await admin`drop database if exists ${admin(name)} with (force)`;
    await admin`create database ${admin(name)}`;
    await admin.end();
    const previous = mkdtempSync(join(tmpdir(), "haben-migrationen-"));
    cpSync(MIGRATIONS, previous, { recursive: true });
    const full = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
    const idx = full.entries.findIndex((e: { tag: string }) => e.tag.endsWith(MIGRATION));
    expect(idx).toBeGreaterThan(0);
    writeFileSync(join(previous, "meta", "_journal.json"), JSON.stringify({ ...full, entries: full.entries.slice(0, idx) }));
    sql = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(drizzle(sql), { migrationsFolder: previous });
    await bestand();
    eintraegeVorher = (await sql<{ n: number }[]>`select count(*)::int as n from audit_log`)[0]!.n;
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
  });

  const befunde = () => sql`select art, tabelle, zeile, befund from haben_integrity_problems(100)`;
  const eintraege = (table: string) =>
    sql<
      { action: string; actor: string | null; row_id: string | null; old_value: Record<string, unknown> | null; new_value: Record<string, unknown> | null }[]
    >`
      select action, actor, row_id, old_value, new_value from audit_log where table_name = ${table} order by seq`;

  /**
   * Einträge ohne den einen der späteren Migration 0352 (#1975): Sie gibt dem offenen Entwurf ohne Kategorie seine Position
   * je Satz, mit eigenem Eintrag als system:migration. Diese Migration selbst trägt nichts nach.
   */
  const eintraegeOhnePositionen = async () =>
    (
      await sql<{ n: number }[]>`select count(*)::int as n from audit_log
        where not (table_name = 'document_splits' and action = 'INSERT' and actor = 'system:migration')`
    )[0]!.n;

  it("trägt nichts nach; Kette, Siegel und Sollbestand ohne Befund", async () => {
    expect(await eintraegeOhnePositionen()).toBe(eintraegeVorher);
    expect((await eintraege("document_splits")).map((e) => [e.action, e.actor, e.new_value?.document_id, e.new_value?.category, e.new_value?.net])).toEqual([
      ["INSERT", "system:migration", ID.belegEntwurf, null, 5000],
    ]);
    expect(await befunde()).toEqual([]);
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { checkTriggerIntegrity } = await import("./trigger-inventory.ts");
    expect(await checkTriggerIntegrity(drizzle(sql))).toEqual({ problems: [], hints: [] });
  });

  it("legt die Audit-Trigger an wie bei document_splits; journal_lines bleibt ohne", async () => {
    // tgtype: 1 = je Zeile, 2 = BEFORE (hier nicht gesetzt: AFTER), 4 = INSERT, 8 = DELETE, 16 = UPDATE
    const trigger = await sql<{ tabelle: string; name: string; tgtype: number }[]>`
      select c.relname as tabelle, t.tgname as name, t.tgtype::int as tgtype from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where t.tgfoid = 'haben_audit'::regproc and c.relname in ('document_amounts', 'document_splits', 'invoice_lines', 'invoice_taxes', 'journal_lines')
       order by c.relname`;
    expect(trigger).toEqual([
      { tabelle: "document_amounts", name: "document_amounts_audit", tgtype: 29 },
      { tabelle: "document_splits", name: "document_splits_audit", tgtype: 29 },
      { tabelle: "invoice_lines", name: "invoice_lines_audit", tgtype: 29 },
      { tabelle: "invoice_taxes", name: "invoice_taxes_audit", tgtype: 29 },
    ]);
  });

  it("festgeschriebener Bestand: Änderungen bleiben abgelehnt und schreiben nichts ins Audit-Log", async () => {
    await expect(sql`update invoice_lines set net = 1 where invoice_id = ${ID.rechnung}`).rejects.toThrow(/festgeschrieben/);
    await expect(sql`delete from invoice_taxes where invoice_id = ${ID.rechnung}`).rejects.toThrow(/festgeschrieben/);
    await expect(sql`update document_amounts set net = 1 where document_id = ${ID.beleg}`).rejects.toThrow(/gebucht/);
    expect(await eintraegeOhnePositionen()).toBe(eintraegeVorher);
    expect(await befunde()).toEqual([]);
  });

  it("Entwurf von vorher: die nächste Änderung steht mit altem Wert im Audit-Log, ohne INSERT davor", async () => {
    await sql.begin(async (tx) => {
      await tx`select set_config('haben.actor', 'test:nachher', true)`;
      await tx`update invoice_taxes set base = 20000, tax = 3800 where invoice_id = ${ID.entwurf} and rate = 1900`;
      await tx`delete from document_amounts where document_id = ${ID.belegEntwurf}`;
    });
    // invoice_taxes hat weder id noch year: row_id bleibt leer, der Schlüssel steht im Wert
    expect(await eintraege("invoice_taxes")).toEqual([
      {
        action: "UPDATE",
        actor: "test:nachher",
        row_id: null,
        old_value: expect.objectContaining({ invoice_id: ID.entwurf, rate: 1900, base: 10000, tax: 1900 }),
        new_value: expect.objectContaining({ invoice_id: ID.entwurf, rate: 1900, base: 20000, tax: 3800 }),
      },
    ]);
    expect(await eintraege("document_amounts")).toEqual([
      expect.objectContaining({
        action: "DELETE",
        actor: "test:nachher",
        old_value: expect.objectContaining({ document_id: ID.belegEntwurf, net: 5000 }),
        new_value: null,
      }),
    ]);

    // Ein gelöschter Entwurf nimmt Positionen und Steuerzeilen über ON DELETE CASCADE mit, jede mit eigenem Eintrag
    await sql.begin(async (tx) => {
      await tx`select set_config('haben.actor', 'test:nachher', true)`;
      await tx`delete from invoices where id = ${ID.entwurf}`;
    });
    expect((await eintraege("invoice_lines")).map((e) => [e.action, e.actor, e.old_value?.invoice_id])).toEqual([
      ["DELETE", "test:nachher", ID.entwurf],
      ["DELETE", "test:nachher", ID.entwurf],
    ]);
    expect((await eintraege("invoice_taxes")).map((e) => e.action)).toEqual(["UPDATE", "DELETE", "DELETE"]);
    expect(await befunde()).toEqual([]);
  });

  it("TRUNCATE bleibt abgelehnt; das Leeren in Tests (leeren, Trigger aus) schreibt nichts ins Audit-Log", async () => {
    await expect(sql`truncate invoice_taxes`).rejects.toThrow(/darf nicht geleert werden/);
    const anzahl = async () => (await sql<{ n: number }[]>`select count(*)::int as n from audit_log`)[0]!.n;
    const vorher = await anzahl();
    // Wie leeren() aus test-db.ts; Zeilen-Trigger feuern bei TRUNCATE ohnehin nicht
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`truncate invoice_taxes, invoice_lines, document_amounts`;
    });
    expect(await anzahl()).toBe(vorher);
  });
});
