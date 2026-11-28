import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Siegel für festgeschriebene Angebote und gebuchte Anlagen (#2039). Beide sperren Trigger, aber erst ein Siegel lässt eine
 * Änderung bei abgeschalteten Triggern auffallen. Was nach dem Festschreiben bzw. der ersten Buchung änderbar bleibt
 * (Entscheidung und Rechnung eines Angebots; Name, Notiz, Abgang, Sonder-AfA und Wechsel zur linearen AfA einer Anlage),
 * geht nicht ins Siegel ein.
 */
describe.skipIf(!testDatabaseUrl)("Siegel für Angebote und Anlagen (Postgres)", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = await setupTestDb();
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  const problems = (tx: postgres.Sql | postgres.TransactionSql = sql) =>
    tx<{ art: string; tabelle: string; zeile: string | null; befund: string }[]>`select art, tabelle, zeile, befund from haben_integrity_problems()`;

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

  const seals = (id: string) => sql<{ table_name: string; columns: Record<string, string[]>; genesis: boolean }[]>`
    select table_name, columns, genesis from seals where row_id = ${id}`;

  let nr = 0;
  async function draftQuote() {
    nr += 1;
    const [q] = await sql`insert into quotes (issue_date, valid_until, net, tax, gross, pdf)
      values ('2026-01-10', '2026-02-10', 10000, 1900, 11900, ${Buffer.from("%PDF-1.7 Angebot")}) returning id`;
    await sql`insert into quote_lines (quote_id, position, description, quantity, unit, unit_price, tax_rate, net)
      values (${q!.id}, 1, 'Beratung', 1000, 'h', 10000, 1900, 10000)`;
    await sql`insert into quote_attachments (quote_id, filename, mime_type, sha256, size)
      values (${q!.id}, 'plan.pdf', 'application/pdf', ${"a".repeat(64)}, 10)`;
    return q!.id as string;
  }

  async function lockedQuote() {
    const id = await draftQuote();
    await sql`update quotes set status = 'final', number = ${`AN-2026-${nr}`}, locked_at = now() where id = ${id}`;
    return id;
  }

  async function lockedEntry() {
    return sql.begin(async (tx) => {
      const [e] = await tx`insert into journal_entries (date, description, source_type, source_id, kontenrahmen)
        values ('2026-12-31', 'AfA', 'asset', gen_random_uuid(), 'SKR03') returning id`;
      await tx`insert into journal_lines (entry_id, account, debit, credit) values (${e!.id}, '4830', 50000, 0), (${e!.id}, '0650', 0, 50000)`;
      await tx`update journal_entries set locked_at = now() where id = ${e!.id}`;
      return e!.id as string;
    });
  }

  async function asset(degressiv = false) {
    const [a] = degressiv
      ? await sql`insert into assets (name, kind, method, degressive_rate, account, acquisition_date, cost, useful_life_months)
          values ('Maschine', 'sonstige', 'degressiv', 2000, '0440', '2026-01-05', 150000, 120) returning id`
      : await sql`insert into assets (name, kind, method, account, acquisition_date, cost, useful_life_months)
          values ('Laptop', 'edv', 'linear', '0650', '2026-01-05', 150000, 36) returning id`;
    return a!.id as string;
  }

  async function bookedAsset(degressiv = false) {
    const id = await asset(degressiv);
    await sql`insert into asset_depreciations (asset_id, year, depreciation, entry_id) values (${id}, 2026, 50000, ${await lockedEntry()})`;
    return id;
  }

  describe("Angebote", () => {
    it("versiegelt beim Festschreiben samt Positionen und Anhängen, ohne Entscheidung und Rechnung", async () => {
      const entwurf = await draftQuote();
      expect(await seals(entwurf)).toEqual([]);
      const id = await lockedQuote();
      const [siegel, ...weitere] = await seals(id);
      expect(weitere).toEqual([]);
      expect(siegel).toMatchObject({ table_name: "quotes", genesis: false });
      expect(Object.keys(siegel!.columns).sort()).toEqual(["quote_attachments", "quote_lines", "quotes"]);
      expect(siegel!.columns.quotes).toEqual(expect.arrayContaining(["gross", "pdf", "locked_at"]));
      for (const spalte of ["decision", "decided_at", "invoice_id", "updated_at"]) expect(siegel!.columns.quotes).not.toContain(spalte);
      expect(await problems()).toEqual([]);
    });

    it("bleibt gültig, wenn sich Entscheidung oder Rechnung ändern", async () => {
      const id = await lockedQuote();
      const [rechnung] = await sql`insert into invoices (issue_date, due_date, net, tax, gross) values ('2026-02-01', '2026-02-15', 10000, 1900, 11900)
        returning id`;
      await sql`update quotes set decision = 'angenommen', decided_at = now(), invoice_id = ${rechnung!.id}, updated_at = now() where id = ${id}`;
      expect(await problems()).toEqual([]);
    });

    it.each([
      { was: "Betrag", aendern: (tx: postgres.TransactionSql, id: string) => tx`update quotes set gross = 1 where id = ${id}` },
      { was: "PDF", aendern: (tx: postgres.TransactionSql, id: string) => tx`update quotes set pdf = ${Buffer.from("%PDF-1.7 anders")} where id = ${id}` },
      { was: "Position", aendern: (tx: postgres.TransactionSql, id: string) => tx`update quote_lines set net = 1 where quote_id = ${id}` },
      {
        was: "neue Position",
        aendern: (
          tx: postgres.TransactionSql,
          id: string,
        ) => tx`insert into quote_lines (quote_id, position, description, quantity, unit, unit_price, tax_rate, net)
          values (${id}, 2, 'Extra', 1000, 'h', 1, 1900, 1)`,
      },
      {
        was: "Anhang",
        aendern: (tx: postgres.TransactionSql, id: string) => tx`update quote_attachments set sha256 = ${"b".repeat(64)} where quote_id = ${id}`,
      },
    ])("meldet $was eines festgeschriebenen Angebots, still geändert", async ({ aendern }) => {
      const id = await lockedQuote();
      const found = await rolledBack(async (tx) => {
        await tamper(tx, () => aendern(tx, id));
        return problems(tx);
      });
      expect(found).toEqual([{ art: "siegel", tabelle: "quotes", zeile: id, befund: "Inhalt passt nicht zum Siegel" }]);
    });

    it("meldet ein gelöschtes Angebot und eine aufgehobene Festschreibung", async () => {
      const id = await lockedQuote();
      const geloescht = await rolledBack(async (tx) => {
        await tamper(tx, async () => {
          await tx`delete from quote_lines where quote_id = ${id}`;
          await tx`delete from quote_attachments where quote_id = ${id}`;
          await tx`delete from quotes where id = ${id}`;
        });
        return problems(tx);
      });
      expect(geloescht).toEqual([{ art: "siegel", tabelle: "quotes", zeile: id, befund: "Versiegelter Datensatz fehlt" }]);
      const aufgehoben = await rolledBack(async (tx) => {
        await tamper(tx, () => tx`update quotes set status = 'draft', number = null, locked_at = null where id = ${id}`);
        return problems(tx);
      });
      expect(aufgehoben).toEqual([{ art: "siegel", tabelle: "quotes", zeile: id, befund: "Festschreibung aufgehoben" }]);
    });

    it("schreibt Positionen auch im Entwurf ins Audit-Log", async () => {
      const id = await draftQuote();
      const [line] = await sql`select id from quote_lines where quote_id = ${id}`;
      const [eintrag] = await sql`select action, new_value from audit_log where table_name = 'quote_lines' and row_id = ${line!.id}`;
      expect(eintrag).toMatchObject({ action: "INSERT", new_value: { quote_id: id, description: "Beratung" } });
    });
  });

  describe("Anlagen", () => {
    it("versiegelt bei der ersten Buchung nur die dann festen Spalten, einmal", async () => {
      const id = await asset();
      await sql`update assets set cost = 160000 where id = ${id}`;
      expect(await seals(id)).toEqual([]);
      await sql`insert into asset_depreciations (asset_id, year, depreciation, entry_id) values (${id}, 2026, 50000, ${await lockedEntry()})`;
      await sql`insert into asset_depreciations (asset_id, year, depreciation, entry_id) values (${id}, 2027, 50000, ${await lockedEntry()})`;
      const [siegel, ...weitere] = await seals(id);
      expect(weitere).toEqual([]);
      expect(siegel).toMatchObject({ table_name: "assets", genesis: false });
      expect(siegel!.columns).toEqual({
        assets: [
          "id",
          "kind",
          "method",
          "account",
          "acquisition_date",
          "cost",
          "useful_life_months",
          "document_id",
          "opening_date",
          "opening_book_value",
          "private_use",
          "degressive_rate",
          "memo_value",
        ],
      });
      expect(await problems()).toEqual([]);
    });

    it("lässt Name, Notiz, Abgang und Sonder-AfA späterer Jahre ohne Befund änderbar", async () => {
      const id = await bookedAsset(true);
      await sql`update assets set name = 'Laptop alt', note = 'Akku getauscht', disposal_date = '2028-06-30',
        special_depreciation = '[{"year": 2028, "amount": 1000}]', linear_from_year = 2028, updated_at = now() where id = ${id}`;
      expect(await problems()).toEqual([]);
    });

    it.each([
      { spalte: "cost", wert: 1 },
      { spalte: "useful_life_months", wert: 120 },
      { spalte: "acquisition_date", wert: "2020-01-01" },
    ])("meldet $spalte einer gebuchten Anlage, still geändert", async ({ spalte, wert }) => {
      const id = await bookedAsset();
      const found = await rolledBack(async (tx) => {
        await tamper(tx, () => tx`update assets set ${tx(spalte)} = ${wert} where id = ${id}`);
        return problems(tx);
      });
      expect(found).toEqual([{ art: "siegel", tabelle: "assets", zeile: id, befund: "Inhalt passt nicht zum Siegel" }]);
    });

    it("versiegelt eine übernommene Anlage bei ihrer Eröffnungsbuchung", async () => {
      const [a] = await sql`insert into assets (name, kind, method, account, acquisition_date, cost, useful_life_months, opening_date, opening_book_value)
        values ('Maschine', 'sonstige', 'linear', '0440', '2022-01-05', 500000, 120, '2026-01-01', 380000) returning id`;
      expect(await seals(a!.id)).toEqual([]);
      await sql`update assets set opening_entry_id = ${await lockedEntry()} where id = ${a!.id}`;
      expect(await seals(a!.id)).toEqual([expect.objectContaining({ table_name: "assets" })]);
      const found = await rolledBack(async (tx) => {
        await tamper(tx, () => tx`update assets set opening_book_value = 1 where id = ${a!.id}`);
        return problems(tx);
      });
      expect(found).toEqual([{ art: "siegel", tabelle: "assets", zeile: a!.id, befund: "Inhalt passt nicht zum Siegel" }]);
    });

    it("meldet eine gebuchte Anlage ohne Siegel", async () => {
      const id = await asset();
      const entry = await lockedEntry();
      const found = await rolledBack(async (tx) => {
        await tamper(tx, () => tx`insert into asset_depreciations (asset_id, year, depreciation, entry_id) values (${id}, 2026, 50000, ${entry})`);
        return (await problems(tx)).filter((p) => p.tabelle === "assets");
      });
      expect(found).toEqual([{ art: "siegel", tabelle: "assets", zeile: id, befund: "Festgeschrieben, aber ohne Siegel" }]);
    });
  });
});
