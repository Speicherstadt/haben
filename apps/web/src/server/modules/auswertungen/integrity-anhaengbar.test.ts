import { readFileSync } from "node:fs";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Nur anhängbare Tabellen ohne Siegel (#861): Ihr Audit-Trigger schreibt jede Zeile beim Einfügen ins Audit-Log. Ändern
 * oder löschen geht nur mit abgeschalteten Triggern; haben_integrity_problems (0339) vergleicht deshalb jede Zeile mit
 * dem Eintrag, mit dem sie dorthin kam.
 */
describe.skipIf(!testDatabaseUrl)("Nur anhängbare Tabellen gegen das Audit-Log (Postgres)", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = await setupTestDb();
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  type Problem = { art: string; tabelle: string; zeile: string | null; seq: string | null; befund: string };
  const problems = (tx: postgres.Sql | postgres.TransactionSql = sql) => tx<Problem[]>`select art, tabelle, zeile, seq, befund from haben_integrity_problems()`;

  /** Führt work in einer Transaktion aus, die danach zurückgerollt wird; liefert ihr Ergebnis */
  async function rolledBack<T>(work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let result: T;
    const rollback = new Error("rollback");
    await sql
      .begin(async (tx) => {
        result = await work(tx);
        throw rollback;
      })
      .catch((error) => {
        if (error !== rollback) throw error;
      });
    return result!;
  }

  /** Wie ein Betreiber mit vollem Zugriff: Trigger abgeschaltet */
  async function tamper(tx: postgres.TransactionSql, work: () => Promise<unknown>) {
    await tx`set local session_replication_role = replica`;
    await work();
    await tx`set local session_replication_role = origin`;
  }

  /** Nummer des Eintrags, mit dem die Zeile ins Audit-Log kam */
  async function eintrag(tabelle: string, id: string) {
    const [row] = await sql`select seq from audit_log where table_name = ${tabelle} and row_id = ${id} and action = 'INSERT'`;
    return row!.seq as string;
  }

  async function lockedInvoice() {
    const [i] = await sql`insert into invoices (issue_date, due_date, net, tax, gross, pdf)
      values ('2026-01-10', '2026-01-24', 10000, 1900, 11900, ${Buffer.from("%PDF-1.7")}) returning id`;
    await sql`insert into invoice_lines (invoice_id, position, description, quantity, unit, unit_price, tax_rate, net)
      values (${i!.id}, 1, 'Beratung', 1000, 'h', 10000, 1900, 10000)`;
    await sql`insert into invoice_taxes (invoice_id, rate, base, tax) values (${i!.id}, 1900, 10000, 1900)`;
    await sql`update invoices set status = 'final', number = ${`2026-${i!.id.slice(0, 6)}`}, locked_at = now() where id = ${i!.id}`;
    return i!.id as string;
  }

  /** Verrechnung zweier festgeschriebener Rechnungen; ohne Trigger, wenn tx mit abgeschalteten Triggern übergeben wird */
  async function settlement(tx: postgres.Sql | postgres.TransactionSql = sql, ids?: { invoice: string; counter: string }) {
    const { invoice, counter } = ids ?? { invoice: await lockedInvoice(), counter: await lockedInvoice() };
    const [s] = await tx`insert into invoice_settlements (invoice_id, counter_invoice_id, date, amount, created_by)
      values (${invoice}, ${counter}, '2026-02-01', 5000, 'test') returning id`;
    return s!.id as string;
  }

  let nr = 0;
  /** Bankumsatz wie aus einem Import, mit Konto und Abruf */
  async function bankTransaction() {
    nr += 1;
    const [konto] =
      await sql`insert into bank_accounts (name, iban) values (${`Giro ${nr}`}, ${`DE893704004405320130${String(nr).padStart(2, "0")}`}) returning id`;
    const [abruf] = await sql`insert into bank_imports (bank_account_id, filename, sha256, format, added, skipped)
      values (${konto!.id}, ${`Auszug ${nr}`}, ${String(nr % 10).repeat(64)}, 'camt', 1, 0) returning id`;
    const [umsatz] = await sql`insert into bank_transactions (bank_account_id, import_id, booking_date, amount, purpose, dedup_hash)
      values (${konto!.id}, ${abruf!.id}, '2026-11-12', -4999, 'Rechnung 9/2026', ${`umsatz-${nr}`}) returning id`;
    await sql`insert into bank_import_transactions (bank_import_id, transaction_id) values (${abruf!.id}, ${umsatz!.id})`;
    return { id: umsatz!.id as string, importId: abruf!.id as string };
  }

  it("meldet eine geänderte Zeile mit dem Eintrag, an dem sie abweicht", async () => {
    const id = await settlement();
    expect(await problems()).toEqual([]);
    const found = await rolledBack(async (tx) => {
      await tamper(tx, () => tx`update invoice_settlements set amount = 1 where id = ${id}`);
      return problems(tx);
    });
    expect(found).toEqual([
      { art: "siegel", tabelle: "invoice_settlements", zeile: id, seq: await eintrag("invoice_settlements", id), befund: "Zeile weicht vom Audit-Log ab" },
    ]);
  });

  it("meldet eine gelöschte Zeile", async () => {
    const id = await settlement();
    const found = await rolledBack(async (tx) => {
      await tamper(tx, () => tx`delete from invoice_settlements where id = ${id}`);
      return problems(tx);
    });
    expect(found).toEqual([
      {
        art: "siegel",
        tabelle: "invoice_settlements",
        zeile: id,
        seq: await eintrag("invoice_settlements", id),
        befund: "Zeile fehlt, steht aber im Audit-Log",
      },
    ]);
  });

  // Ein Eintrag lässt sich mit eingeschalteten Triggern ans Audit-Log anhängen; die Kette bleibt dabei heil, ebenso jeder
  // Prüfwert von außerhalb. Ändern oder löschen lässt haben_append_only diese Zeilen nie, maßgeblich ist ihr Einfügen.
  it("meldet eine gelöschte Zeile auch nach einem angehängten DELETE-Eintrag", async () => {
    const id = await settlement();
    const found = await rolledBack(async (tx) => {
      await tamper(tx, () => tx`delete from invoice_settlements where id = ${id}`);
      await tx`insert into audit_log (actor, table_name, row_id, action, old_value, new_value)
        select 'test', 'invoice_settlements', ${id}, 'DELETE', new_value, null
          from audit_log where table_name = 'invoice_settlements' and row_id = ${id} and action = 'INSERT'`;
      // Den Kopf der Kette setzt ein aufgeschobener Trigger erst beim Commit
      await tx`set constraints all immediate`;
      return problems(tx);
    });
    expect(found).toEqual([
      {
        art: "siegel",
        tabelle: "invoice_settlements",
        zeile: id,
        seq: await eintrag("invoice_settlements", id),
        befund: "Zeile fehlt, steht aber im Audit-Log",
      },
    ]);
  });

  it("meldet eine geänderte Zeile auch nach einem angehängten Eintrag mit dem neuen Wert", async () => {
    const id = await settlement();
    const found = await rolledBack(async (tx) => {
      await tamper(tx, () => tx`update invoice_settlements set amount = 1 where id = ${id}`);
      await tx`insert into audit_log (actor, table_name, row_id, action, old_value, new_value)
        select 'test', 'invoice_settlements', ${id}, 'INSERT', null, to_jsonb(s) from invoice_settlements s where s.id = ${id}`;
      await tx`set constraints all immediate`;
      return problems(tx);
    });
    expect(found).toEqual([
      { art: "siegel", tabelle: "invoice_settlements", zeile: id, seq: await eintrag("invoice_settlements", id), befund: "Zeile weicht vom Audit-Log ab" },
    ]);
  });

  it("meldet eine Zeile, die an den Triggern vorbei eingefügt wurde", async () => {
    const ids = { invoice: await lockedInvoice(), counter: await lockedInvoice() };
    const found = await rolledBack(async (tx) => {
      let id = "";
      await tamper(tx, async () => {
        id = await settlement(tx, ids);
      });
      return { id, found: await problems(tx) };
    });
    expect(found.found).toEqual([{ art: "siegel", tabelle: "invoice_settlements", zeile: found.id, seq: null, befund: "Zeile steht nicht im Audit-Log" }]);
  });

  // Bankumsätze standen bis 0339 gar nicht im Audit-Log (#861, erstes Akzeptanzkriterium)
  it("schreibt Bankumsätze ins Audit-Log und meldet einen geänderten", async () => {
    const { id } = await bankTransaction();
    const [audited] = await sql`select new_value from audit_log where table_name = 'bank_transactions' and row_id = ${id}`;
    expect(audited!.new_value).toMatchObject({ id, amount: -4999, purpose: "Rechnung 9/2026" });
    const found = await rolledBack(async (tx) => {
      await tamper(tx, () => tx`update bank_transactions set amount = -49990 where id = ${id}`);
      return problems(tx);
    });
    expect(found).toEqual([
      { art: "siegel", tabelle: "bank_transactions", zeile: id, seq: await eintrag("bank_transactions", id), befund: "Zeile weicht vom Audit-Log ab" },
    ]);
  });

  it("findet Zeilen ohne id über ihren Primärschlüssel", async () => {
    const { id, importId } = await bankTransaction();
    const found = await rolledBack(async (tx) => {
      await tamper(tx, () => tx`delete from bank_import_transactions where transaction_id = ${id}`);
      return problems(tx);
    });
    expect(found).toEqual([
      expect.objectContaining({ tabelle: "bank_import_transactions", zeile: `${importId}:${id}`, befund: "Zeile fehlt, steht aber im Audit-Log" }),
    ]);
  });

  it("schreibt neue Kontaktversionen ins Audit-Log", async () => {
    const [kontakt] = await sql`insert into contacts (name) values ('Kunde Version') returning id`;
    await sql`update contacts set name = 'Kunde Version GmbH' where id = ${kontakt!.id}`;
    const versionen = await sql`select v.id::text as id, a.seq from contact_versions v
      left join audit_log a on a.table_name = 'contact_versions' and a.row_id = v.id::text where v.contact_id = ${kontakt!.id}`;
    expect(versionen.length).toBeGreaterThan(0);
    expect(versionen.filter((v) => v.seq === null)).toEqual([]);
    expect(await problems()).toEqual([]);
  });

  // Zeitpunkte schreibt to_jsonb mit der Zeitzone der Sitzung; verglichen wird der Zeitpunkt, nicht der Text
  it("vergleicht Zeitpunkte unabhängig von der Zeitzone der schreibenden Sitzung", async () => {
    const ids = { invoice: await lockedInvoice(), counter: await lockedInvoice() };
    await sql.begin(async (tx) => {
      await tx`set local time zone 'America/New_York'`;
      await settlement(tx, ids);
    });
    expect(
      await rolledBack(async (tx) => {
        await tx`set local time zone 'Asia/Tokyo'`;
        return problems(tx);
      }),
    ).toEqual([]);
  });

  // Ältere Einträge kennen eine später ergänzte Spalte nicht; sie bleibt dort ungeprüft (Grenze in docs/buchhaltung.md)
  it("lässt Spalten aus, die ein älterer Eintrag nicht kennt", async () => {
    const id = await settlement();
    const found = await rolledBack(async (tx) => {
      await tx`alter table invoice_settlements add column zusatz text not null default 'neu'`;
      const ohne = await problems(tx);
      await tamper(tx, () => tx`update invoice_settlements set zusatz = 'still geändert' where id = ${id}`);
      return { ohne, still: await problems(tx) };
    });
    expect(found).toEqual({ ohne: [], still: [] });
  });

  it("meldet einen Wert, der sich nicht mehr in den Spaltentyp wandeln lässt, statt abzubrechen", async () => {
    await settlement();
    const found = await rolledBack(async (tx) => {
      await tx`alter table invoice_settlements alter column created_by type integer using 0`;
      return problems(tx);
    });
    expect(found).toEqual([
      { art: "siegel", tabelle: "invoice_settlements", zeile: null, seq: null, befund: expect.stringMatching(/^Abgleich mit dem Audit-Log nicht möglich: /) },
    ]);
  });

  // Vollständigkeit (#861): Jede nur anhängbare Tabelle hat ein Siegel oder wird mit dem Audit-Log abgeglichen. Eine neue
  // Tabelle mit haben_append_only kommt in haben_audited_append_only_tables oder bekommt ein Siegel.
  it("gleicht jede nur anhängbare Tabelle ohne Siegel mit dem Audit-Log ab", async () => {
    const inventory = JSON.parse(readFileSync(new URL("../../db/trigger-inventory.json", import.meta.url), "utf8")) as { sealedTables: string[] };
    const versiegelt = new Set(inventory.sealedTables.map((t) => t.replace(/^public\./, "")));
    // Sie selbst trägt die Kette (audit_log, audit_chain) bzw. 0311 gleicht sie ab (seals)
    const ausnahmen = new Set(["audit_log", "audit_chain", "seals"]);
    // tgtype: 1 = je Zeile, 8 = DELETE, 16 = UPDATE
    const nurAnhaengbar = await sql<{ name: string }[]>`select distinct c.relname as name from pg_trigger t
      join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and c.relnamespace = 'public'::regnamespace and p.proname = 'haben_append_only'
        and t.tgtype & 25 = 25 order by 1`;
    const erwartet = nurAnhaengbar.map((r) => r.name).filter((t) => !versiegelt.has(t) && !ausnahmen.has(t));
    expect(erwartet).toEqual(expect.arrayContaining(["bank_transactions", "invoice_settlements", "dunnings"]));
    const [liste] = await sql<{ tabellen: string[] }[]>`select haben_audited_append_only_tables() as tabellen`;
    expect([...liste!.tabellen].sort()).toEqual(erwartet);

    // Ohne Audit-Trigger beim Einfügen meldete der Abgleich jede Zeile
    const mitAudit = await sql<{ name: string }[]>`select distinct c.relname as name from pg_trigger t
      join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and c.relnamespace = 'public'::regnamespace and p.proname = 'haben_audit' and t.tgtype & 4 = 4`;
    const auditiert = new Set(mitAudit.map((r) => r.name));
    expect(erwartet.filter((t) => !auditiert.has(t))).toEqual([]);
  });
});
