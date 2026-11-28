import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { problems, rolledBack, tamper } from "../modules/auswertungen/test-anhaengbar.ts";
import { testDatabaseUrl } from "../test-db.ts";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/*
 * Migration „Hashes weggelassener Spalten“ (#2038, 0354): Einträge von vorher haben keine Hashes von PDF und XML. Die Migration trägt sie für jede solche
 * Zeile nachträglich ein, mit Hinweis in der Kette; danach meldet der Abgleich nichts, und eine still getauschte Datei
 * fällt auf.
 */
describe.skipIf(!testDatabaseUrl)("Migration: Hashes von PDF und XML im Bestand (Postgres)", () => {
  let sql: postgres.Sql;

  /** Jeder Test beginnt mit einer frischen Datenbank auf dem Stand vor dieser Migration */
  beforeEach(async () => {
    await sql?.end();
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
      await migrieren(sql, previous);
    } finally {
      rmSync(previous, { recursive: true, force: true });
    }
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function migrieren(db: postgres.Sql, migrationsFolder = MIGRATIONS) {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(drizzle(db), { migrationsFolder });
  }

  /** Eine gesendete Voranmeldung mit Protokoll, über die Trigger eingefügt */
  async function uebermittlung(pdf: Buffer) {
    return sql.begin(async (tx) => {
      await tx`select set_config('haben.actor', 'test:vorher', true)`;
      const [voranmeldung] = await tx`insert into vat_returns (year, month) values (2025, 12) returning id`;
      const [u] = await tx`insert into vat_return_submissions (vat_return_id, kind, ok, code, message, request_xml, response_xml,
          server_response_xml, protocol_pdf)
        values (${voranmeldung!.id}, 'send', true, 0, 'ok', '<Elster/>', '<Antwort/>', '<Server/>', ${pdf}) returning id`;
      return u!.id as string;
    });
  }

  /** Ein angehängter INSERT-Eintrag der Übermittlung, der als Protokoll den Hash von pdf nennt */
  const hashEintrag = (db: postgres.Sql | postgres.TransactionSql, id: string, pdf: Buffer) =>
    db`insert into audit_log (actor, table_name, row_id, action, old_value, new_value)
      select 'test', 'vat_return_submissions', ${id}, 'INSERT', null,
             (to_jsonb(u) - 'protocol_pdf' - 'request_xml' - 'response_xml' - 'server_response_xml')
               || jsonb_build_object('omitted_sha256', jsonb_build_object('protocol_pdf', ${sha256(pdf)}::text))
        from vat_return_submissions u where u.id = ${id}`;

  /** Befunde nach still getauschtem Protokoll, zurückgerollt */
  const nachTausch = (id: string, pdf: Buffer, vorher?: (tx: postgres.TransactionSql) => Promise<unknown>) =>
    rolledBack(sql, async (tx) => {
      await tamper(tx, async () => {
        await vorher?.(tx);
        await tx`update vat_return_submissions set protocol_pdf = ${pdf} where id = ${id}`;
      });
      return problems(tx);
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
      // Ebenso Einträge mit einem Hash, der erst nach dem Update stimmen soll: der einer untergeschobenen Datei und null
      // (Datei gelöscht). Sie zählen nicht, weil sie vor dem Stichtag liegen (audit_hash_since).
      await tx`insert into audit_log (actor, table_name, row_id, action, old_value, new_value)
        select 'test', 'sepa_transfers', ${vorher.ueberweisung}, 'INSERT', null,
               (to_jsonb(s) - 'xml') || jsonb_build_object('omitted_sha256', jsonb_build_object('xml', ${sha256("<Document>gefälscht</Document>")}::text))
          from sepa_transfers s where s.id = ${vorher.ueberweisung}`;
      await tx`insert into audit_log (actor, table_name, row_id, action, old_value, new_value)
        select 'test', 'vat_return_submissions', ${vorher.uebermittlung}, 'INSERT', null,
               (to_jsonb(u) - 'protocol_pdf' - 'request_xml' - 'response_xml' - 'server_response_xml') || '{"omitted_sha256": {"protocol_pdf": null}}'::jsonb
          from vat_return_submissions u where u.id = ${vorher.uebermittlung}`;
    });
    const [kopf] = await sql`select seq from audit_chain`;

    await migrieren(sql);

    const nachgetragen = await sql`select table_name, row_id, actor, new_value from audit_log where seq > ${kopf!.seq} order by seq`;
    expect(await sql`select id, seq from audit_hash_since`).toEqual([{ id: 1, seq: kopf!.seq }]);
    expect(nachgetragen.map((e) => [e.table_name, e.row_id, e.actor])).toEqual([
      ["audit_hash_since", "1", "system:migration"],
      ["sepa_transfers", vorher.ueberweisung, "system:migration"],
      ["vat_return_submissions", vorher.uebermittlung, "system:migration"],
      ["audit_chain", "1", "system:migration"],
    ]);
    expect(nachgetragen[1]!.new_value).toMatchObject({ id: vorher.ueberweisung, omitted_sha256: { xml: sha256("<Document/>") } });
    expect(nachgetragen[2]!.new_value).not.toHaveProperty("protocol_pdf");
    expect(nachgetragen[2]!.new_value).toMatchObject({ omitted_sha256: { protocol_pdf: sha256(pdf), request_xml: sha256("<Elster/>") } });
    expect(nachgetragen[3]!.new_value).toEqual({
      hinweis: expect.stringContaining("nachträglich eingetragen"),
      tabellen: { sepa_transfers: 1, vat_return_submissions: 1 },
    });
    expect(await problems(sql)).toEqual(nichtImAuditLog);

    // Genau die Fälschungen, auf die die vorab angehängten Einträge passen
    const befunde = await rolledBack(sql, async (tx) => {
      await tamper(tx, async () => {
        await tx`update vat_return_submissions set protocol_pdf = null where id = ${vorher.uebermittlung}`;
        await tx`update sepa_transfers set xml = '<Document>gefälscht</Document>' where id = ${vorher.ueberweisung}`;
      });
      return problems(tx);
    });
    expect(befunde).toHaveLength(3);
    expect(befunde).toEqual(
      expect.arrayContaining([
        ...nichtImAuditLog,
        expect.objectContaining({ tabelle: "sepa_transfers", zeile: vorher.ueberweisung, befund: "Spalte xml weicht vom Audit-Log ab" }),
        expect.objectContaining({ tabelle: "vat_return_submissions", zeile: vorher.uebermittlung, befund: "Spalte protocol_pdf weicht vom Audit-Log ab" }),
      ]),
    );
  }, 120_000);

  it("ein vor dem Update angehängter Eintrag für audit_hash_since setzt den Stichtag nicht außer Kraft (Review zu #2072)", async () => {
    const pdf = Buffer.from("%PDF-1.7 Protokoll");
    const faelschung = Buffer.from("%PDF-1.7 gefälscht");
    const id = await uebermittlung(pdf);
    await hashEintrag(sql, id, faelschung);
    await sql`insert into audit_log (actor, table_name, row_id, action, old_value, new_value)
      values ('test', 'audit_hash_since', '1', 'INSERT', null, '{"id": 1}'::jsonb)`;
    await migrieren(sql);

    const nichtBelegt = expect.objectContaining({ tabelle: "audit_hash_since", befund: "Stichtag der Hashes von PDF und XML nicht belegt" });
    expect(await problems(sql)).toEqual([nichtBelegt]);
    // Auch mit abgesenktem Stichtag und getauschtem Protokoll bleibt das sichtbar
    expect(await nachTausch(id, faelschung, (tx) => tx`update audit_hash_since set seq = 0 where id = 1`)).toEqual(expect.arrayContaining([nichtBelegt]));
  }, 120_000);

  it("nach dem Update angehängt oder entfernt: der Stichtag ist nicht mehr belegt", async () => {
    await migrieren(sql);
    expect(await problems(sql)).toEqual([]);
    const nichtBelegt = expect.objectContaining({ tabelle: "audit_hash_since", befund: "Stichtag der Hashes von PDF und XML nicht belegt" });
    const entfernt = await rolledBack(sql, async (tx) => {
      await tamper(tx, () => tx`delete from audit_hash_since`);
      return problems(tx);
    });
    expect(entfernt).toEqual(expect.arrayContaining([nichtBelegt]));
    // Bestätigt angehängt, weil audit_chain den Kopf erst beim Commit nachzieht
    await sql`insert into audit_log (actor, table_name, row_id, action, old_value, new_value)
      select 'test', 'audit_hash_since', '1', 'INSERT', null, to_jsonb(h) from audit_hash_since h`;
    expect(await problems(sql)).toEqual([nichtBelegt]);
  }, 120_000);

  it("ein Eintrag einer während des Updates offenen Transaktion liegt vor dem Stichtag (Review zu #2072)", async () => {
    const pdf = Buffer.from("%PDF-1.7 Protokoll");
    const faelschung = Buffer.from("%PDF-1.7 gefälscht");
    const id = await uebermittlung(pdf);
    const b = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    const update = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    try {
      let bestaetigen!: () => void;
      const offen = new Promise<void>((resolve) => {
        bestaetigen = resolve;
      });
      let angehaengt!: () => void;
      const eintragDa = new Promise<void>((resolve) => {
        angehaengt = resolve;
      });
      const sitzungB = b.begin(async (tx) => {
        await hashEintrag(tx, id, faelschung);
        angehaengt();
        await offen;
      });
      await eintragDa;
      const [backend] = await update<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const migration = migrieren(update);
      // Warten, bis das Update auf die Kettensperre von B wartet, dann B bestätigen
      for (let i = 0; i < 600; i++) {
        const [w] = await sql`select wait_event_type from pg_stat_activity where pid = ${backend!.pid}`;
        if (w?.wait_event_type === "Lock") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      bestaetigen();
      await sitzungB;
      await migration;
    } finally {
      await b.end();
      await update.end();
    }
    const [stichtag] = await sql<{ seq: string }[]>`select seq from audit_hash_since`;
    const [vonB] = await sql<{ seq: string }[]>`select max(seq) as seq from audit_log where table_name = 'vat_return_submissions' and actor = 'test'`;
    expect(Number(stichtag!.seq)).toBeGreaterThanOrEqual(Number(vonB!.seq));
    expect(await nachTausch(id, faelschung)).toEqual([
      expect.objectContaining({ tabelle: "vat_return_submissions", zeile: id, befund: "Spalte protocol_pdf weicht vom Audit-Log ab" }),
    ]);
  }, 120_000);
});
