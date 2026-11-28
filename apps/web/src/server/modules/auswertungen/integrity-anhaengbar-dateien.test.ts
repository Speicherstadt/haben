import { createHash } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { problems, rolledBack, tamper } from "./test-anhaengbar.ts";

/*
 * PDF und XML nur anhängbarer Tabellen (#2038): haben_audit schreibt diese Spalten nicht ins Audit-Log, seit 0351 aber
 * ihren SHA-256 unter omitted_sha256. Der Abgleich aus 0339 vergleicht ihn mit der Spalte, sonst ließe sich etwa das
 * Protokoll einer gesendeten Voranmeldung bei abgeschalteten Triggern still austauschen.
 */
describe.skipIf(!testDatabaseUrl)("PDF und XML nur anhängbarer Tabellen gegen das Audit-Log (Postgres)", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = await setupTestDb();
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  const sha256 = (inhalt: string | Buffer) => createHash("sha256").update(inhalt).digest("hex");
  const pdf = Buffer.from("%PDF-1.7 Protokoll");

  let nr = 0;
  async function uebermittlung(protokoll: Buffer | null = pdf) {
    nr += 1;
    const [voranmeldung] = await sql`insert into vat_returns (year, month) values (${2000 + nr}, 1) returning id`;
    const [u] = await sql`insert into vat_return_submissions (vat_return_id, kind, ok, code, message, request_xml, response_xml,
        server_response_xml, protocol_pdf)
      values (${voranmeldung!.id}, 'send', true, 0, 'ok', '<Elster>Anfrage</Elster>', '<Elster>Antwort</Elster>', '<Server/>', ${protokoll})
      returning id`;
    return u!.id as string;
  }

  async function mahnung() {
    const [i] = await sql`insert into invoices (issue_date, due_date, net, tax, gross)
      values ('2026-01-10', '2026-01-24', 10000, 1900, 11900) returning id`;
    await sql`insert into invoice_lines (invoice_id, position, description, quantity, unit, unit_price, tax_rate, net)
      values (${i!.id}, 1, 'Beratung', 1000, 'h', 10000, 1900, 10000)`;
    await sql`insert into invoice_taxes (invoice_id, rate, base, tax) values (${i!.id}, 1900, 10000, 1900)`;
    await sql`update invoices set status = 'final', number = ${`M-${i!.id.slice(0, 8)}`}, locked_at = now() where id = ${i!.id}`;
    const [m] = await sql`insert into dunnings (invoice_id, level, date, due_date, open, total, intro, closing, pdf, pdf_sha256)
      values (${i!.id}, 1, '2026-02-01', '2026-02-15', 11900, 11900, 'Guten Tag', 'Grüße', ${pdf}, ${sha256(pdf)}) returning id`;
    return m!.id as string;
  }

  async function ueberweisung() {
    nr += 1;
    const [konto] = await sql`insert into bank_accounts (name, iban)
      values (${`Giro ${nr}`}, ${`DE893704004405320131${String(nr).padStart(2, "0")}`}) returning id`;
    const [s] = await sql`insert into sepa_transfers (bank_account_id, message_id, execution_date, number_of_transactions, control_sum, xml)
      values (${konto!.id}, ${`MSG-${nr}`}, '2026-03-01', 1, 4999, '<Document>pain.001</Document>') returning id`;
    return s!.id as string;
  }

  async function eintrag(tabelle: string, id: string) {
    const [row] = await sql`select seq, new_value from audit_log where table_name = ${tabelle} and row_id = ${id} and action = 'INSERT'
      order by seq limit 1`;
    return row as { seq: string; new_value: Record<string, unknown> };
  }

  it("schreibt den SHA-256 jeder weggelassenen Spalte in den Eintrag, nicht ihren Inhalt", async () => {
    const id = await mahnung();
    const { new_value } = await eintrag("dunnings", id);
    expect(new_value).not.toHaveProperty("pdf");
    // Bei bytea der Hash der Datei selbst, wie in pdf_sha256
    expect(new_value).toMatchObject({ pdf_sha256: sha256(pdf), omitted_sha256: { pdf: sha256(pdf) } });

    const u = await uebermittlung(null);
    expect((await eintrag("vat_return_submissions", u)).new_value.omitted_sha256).toEqual({
      protocol_pdf: null,
      request_xml: sha256("<Elster>Anfrage</Elster>"),
      response_xml: sha256("<Elster>Antwort</Elster>"),
      server_response_xml: sha256("<Server/>"),
    });
    expect(await problems(sql)).toEqual([]);
  });

  // to_jsonb schreibt bytea nach bytea_output der Sitzung; mit escape entstünde ohne SET bytea_output = 'hex' in
  // haben_audit_omitted_sha256 ein anderer Hash als der der Datei, und die Prüfung meldete eine unveränderte Zeile.
  it("bildet den Hash der Datei auch in einer Sitzung mit bytea_output = escape", async () => {
    const datei = Buffer.from([0x00, 0xff, 0x25, 0x50, 0x44, 0x46]);
    const found = await rolledBack(sql, async (tx) => {
      await tx`set local bytea_output = 'escape'`;
      const [voranmeldung] = await tx`insert into vat_returns (year, month) values (1999, 12) returning id`;
      const [u] = await tx`insert into vat_return_submissions (vat_return_id, kind, ok, code, message, request_xml, response_xml,
          server_response_xml, protocol_pdf)
        values (${voranmeldung!.id}, 'send', true, 0, 'ok', '<Elster>Umlaut ü</Elster>', '<Antwort/>', '<Server/>', ${datei})
        returning id`;
      const [e] = await tx`select new_value -> 'omitted_sha256' as h from audit_log
        where table_name = 'vat_return_submissions' and row_id = ${u!.id} and action = 'INSERT'`;
      await tx`set constraints all immediate`;
      return { hashes: e!.h, befunde: await problems(tx) };
    });
    expect(found.hashes).toMatchObject({ protocol_pdf: sha256(datei), request_xml: sha256("<Elster>Umlaut ü</Elster>") });
    expect(found.befunde).toEqual([]);
  });

  it.each([
    { tabelle: "vat_return_submissions", anlegen: () => uebermittlung(), spalte: "protocol_pdf", neu: Buffer.from("%PDF-1.7 anders") },
    { tabelle: "vat_return_submissions", anlegen: () => uebermittlung(), spalte: "request_xml", neu: "<Elster>geändert</Elster>" },
    { tabelle: "vat_return_submissions", anlegen: () => uebermittlung(null), spalte: "protocol_pdf", neu: Buffer.from("%PDF-1.7 später") },
    { tabelle: "dunnings", anlegen: mahnung, spalte: "pdf", neu: Buffer.from("%PDF-1.7 andere Mahnung") },
    { tabelle: "sepa_transfers", anlegen: ueberweisung, spalte: "xml", neu: "<Document>andere IBAN</Document>" },
  ])("meldet $tabelle, Spalte $spalte, still geändert", async ({ tabelle, anlegen, spalte, neu }) => {
    const id = await anlegen();
    const found = await rolledBack(sql, async (tx) => {
      await tamper(tx, () => tx`update ${tx(tabelle)} set ${tx(spalte)} = ${neu} where id = ${id}`);
      return problems(tx);
    });
    expect(found).toEqual([{ art: "siegel", tabelle, zeile: id, seq: (await eintrag(tabelle, id)).seq, befund: `Spalte ${spalte} weicht vom Audit-Log ab` }]);
  });

  // Einen weiteren Eintrag mit dem Hash der neuen Datei kann jeder mit eingeschalteten Triggern anhängen; maßgeblich ist der
  // erste Eintrag der Zeile mit Hashes.
  it("meldet eine still getauschte Datei auch nach einem angehängten Eintrag mit ihrem Hash", async () => {
    const id = await mahnung();
    const found = await rolledBack(sql, async (tx) => {
      await tamper(tx, () => tx`update dunnings set pdf = ${Buffer.from("%PDF-1.7 Fälschung")} where id = ${id}`);
      await tx`insert into audit_log (actor, table_name, row_id, action, old_value, new_value)
        select 'test', 'dunnings', ${id}, 'INSERT', null, (to_jsonb(d) - 'pdf') || haben_audit_omitted_sha256(d) from dunnings d where d.id = ${id}`;
      await tx`set constraints all immediate`;
      return problems(tx);
    });
    expect(found).toEqual([
      { art: "siegel", tabelle: "dunnings", zeile: id, seq: (await eintrag("dunnings", id)).seq, befund: "Spalte pdf weicht vom Audit-Log ab" },
    ]);
  });

  // Ältere Einträge ohne Hashes bleiben ungeprüft, wie Spalten, die ein älterer Eintrag nicht kennt; für den Bestand trägt
  // 0351 die Hashes nachträglich ein (migrate-hash-weggelassene-spalten.test.ts).
  it("lässt Einträge ohne Hashes aus", async () => {
    const id = await ueberweisung();
    const found = await rolledBack(sql, async (tx) => {
      await tamper(tx, async () => {
        await tx`update audit_log set new_value = new_value - 'omitted_sha256' where table_name = 'sepa_transfers' and row_id = ${id}`;
        await tx`update sepa_transfers set xml = '<Document>ungeprüft</Document>' where id = ${id}`;
      });
      return (await problems(tx)).filter((p) => p.art === "siegel");
    });
    expect(found).toEqual([]);
  });

  // Nur die nur anhängbaren Tabellen gleicht die Prüfung mit dem Audit-Log ab; Zugangsdaten, Logos und versiegelte Rechnungen
  // bekommen keine Hashes (Rechnungen deckt das Siegel ab).
  it("schreibt Hashes nur für nur anhängbare Tabellen", async () => {
    const png = Buffer.from("png");
    await sql`insert into company_logo (id, logo, format, sha256) values (1, ${png}, 'png', ${sha256(png)})
      on conflict (id) do update set logo = excluded.logo`;
    const [logo] = await sql`select new_value from audit_log where table_name = 'company_logo' order by seq desc limit 1`;
    expect(logo!.new_value).not.toHaveProperty("omitted_sha256");
  });

  // Vollständigkeit (#2038): Jede Spalte, die haben_audit weglässt, deckt in einer nur anhängbaren Tabelle der Hash ab;
  // haben_audit nimmt die Liste aus haben_audit_omitted_columns, damit sie nicht auseinanderläuft.
  it("deckt jede weggelassene Spalte einer nur anhängbaren Tabelle mit einem Hash ab", async () => {
    const paare = await sql<{ tabelle: string; spalte: string }[]>`select c.relname as tabelle, a.attname as spalte
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
        and c.relname = any (haben_audited_append_only_tables()) and a.attname = any (haben_audit_omitted_columns())
      order by 1, 2`;
    expect(new Set(paare.map((p) => p.tabelle))).toEqual(
      new Set([
        "annual_submissions",
        "brm_requests",
        "dunnings",
        "elster_messages",
        "kapest_submissions",
        "lsta_submissions",
        "lstb_submissions",
        "postfach_requests",
        "sepa_direct_debits",
        "sepa_transfers",
        "vast_belege",
        "vast_requests",
        "vat_extension_submissions",
        "vat_return_submissions",
        "zm_submissions",
      ]),
    );
    for (const { tabelle, spalte } of paare) {
      const [h] = await sql.unsafe(`select haben_audit_omitted_sha256(null::"${tabelle}") -> 'omitted_sha256' as h`);
      expect(h!.h, `${tabelle}.${spalte}`).toHaveProperty(spalte);
    }
    const [audit] = await sql`select prosrc from pg_proc where proname = 'haben_audit'`;
    expect(audit!.prosrc).toContain("haben_audit_omitted_columns()");
    expect(audit!.prosrc).not.toContain("'protocol_pdf'");
  });
});
