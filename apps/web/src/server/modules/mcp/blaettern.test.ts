import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Listenwerkzeuge blättern mit offset (#1518): je Werkzeug 120 Einträge, drei Aufrufe mit limit 50 liefern zusammen
 * alle und keinen doppelt. Viele Einträge teilen sich Datum und Nummer, damit auch der Gleichstand eine feste
 * Reihenfolge braucht.
 */
describe.skipIf(!testDatabaseUrl)("MCP-Listen mit offset weiterblättern (Postgres)", () => {
  let mcp: typeof import("./index.ts");
  let server: typeof import("./server.ts");
  let tools: typeof import("./tools.ts");
  let sql: postgres.Sql;
  const actor = "test-user";

  beforeAll(async () => {
    sql = await setupTestDb();
    await sql`insert into "user"(id,name,email,role) values (${actor}, 'Testinhaber', 'inhaber@example.de', 'inhaber')`;
    await sql`insert into company (id, name, strasse, plz, ort, steuernummer, bundesland) values (1, 'Testfirma', 'Musterstraße 1', '77815', 'Bühl', '35/123/45678', 'BW')`;
    mcp = await import("./index.ts");
    server = await import("./server.ts");
    tools = await import("./tools.ts");

    await sql`insert into invoices (kind, status, number, locked_at, issue_date, due_date, net, tax, gross)
      select 'rechnung', 'final', 'RE-' || lpad(g::text, 4, '0'), now(), '2026-03-05', '2026-04-05', 10000 + g, 0, 10000 + g from generate_series(1, 120) g`;
    await sql`insert into documents (filename, sha256, mime_type, size, status, payment, supplier_name, invoice_number, category, document_date, due_date, net, tax, gross)
      select 'beleg.pdf', 'sha-' || g, 'application/pdf', 1, 'gebucht', 'bank', 'Nordlicht Technik GmbH', 'R1', 'telefon', '2026-03-01', '2026-03-31',
             20000 + g, 0, 20000 + g from generate_series(1, 120) g`;

    for (const [name, iban] of [
      ["Girokonto", "DE89370400440532013000"],
      ["Tagesgeld", "DE02120300000000202051"],
    ]) {
      const [konto] = await sql`insert into bank_accounts (name, iban, purpose) values (${name!}, ${iban!}, 'geschaeft') returning id`;
      const [imp] = await sql`insert into bank_imports (bank_account_id, filename, sha256, format, added, skipped)
        values (${konto!.id}, 'auszug.csv', ${`sha-${name}`}, 'csv', 120, 0) returning id`;
      await sql`insert into bank_transactions (bank_account_id, import_id, booking_date, amount, counterparty_name, purpose, dedup_hash)
        select ${konto!.id}, ${imp!.id}, '2026-10-20', 100, 'Masse', ${name!} || ' ' || g, ${name!} || '-' || g from generate_series(1, 120) g`;
    }

    const [run] = await sql`insert into lexoffice_imports (status, progress) values ('fertig', '{}'::jsonb) returning id`;
    await sql`insert into legacy_order_documents (external_id, import_id, kind, number, date, status, contact_name, currency, gross, raw)
      select 'an-' || g, ${run!.id}, 'AN', 'AN-1', '2025-04-10', 'open', 'Kunde GmbH', 'EUR', 100, '{}'::jsonb from generate_series(1, 120) g`;
    await sql`insert into lexoffice_vouchers (lexoffice_id, import_id, type, direction, number, date, status, contact_name, net, tax, gross, taxes, categories, raw)
      select 'lx-' || g, ${run!.id}, 'purchaseinvoice', 'ausgabe', 'ER1', '2025-04-10', 'open', 'Lieferant GmbH', 100, 0, 100, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb
      from generate_series(1, 120) g`;

    // Zwei Stapel mit denselben Zeilennummern am selben Tag: Datum und Zeile allein ordnen nicht eindeutig
    for (const stapel of [1, 2]) {
      const [file] = await sql`insert into archive_files (kind, year, filename, sha256, mime_type, size)
        values ('datev', 2025, ${`DATEV_${stapel}.csv`}, ${`datev-${stapel}`}, 'text/csv', 1) returning id`;
      await sql`insert into datev_bookings (file_id, row, date, amount, side, account, contra_account, raw)
        select ${file!.id}, g, '2025-04-10', ${stapel} * 1000 + g, 'S', '1200', '8400', '{}'::jsonb from generate_series(1, 60) g`;
    }
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
  });

  type Antwort = Record<string, unknown>;
  const run = (name: string, args: Record<string, unknown>) =>
    tools.MCP_TOOLS.find((t) => t.name === name)!.run(args as never, tools.todayContext()) as Promise<unknown>;

  /** Drei Seiten zu je 50; `listen` zieht aus einer Antwort die Listen samt Gesamtzahl, `schluessel` unterscheidet die Einträge */
  async function blaettern(
    name: string,
    args: Record<string, unknown>,
    listen: (antwort: unknown) => { total: unknown; eintraege: Antwort[] }[],
    schluessel: (eintrag: Antwort) => unknown,
  ) {
    const seiten = [];
    for (const offset of [0, 50, 100]) seiten.push(listen(await run(name, { ...args, limit: 50, offset })));
    for (const [nr] of seiten[0]!.entries()) {
      const teile = seiten.map((s) => s[nr]!);
      expect(
        teile.map((t) => t.eintraege.length),
        name,
      ).toEqual([50, 50, 20]);
      expect(
        teile.map((t) => t.total),
        name,
      ).toEqual([120, 120, 120]);
      expect(new Set(teile.flatMap((t) => t.eintraege.map(schluessel))).size, name).toBe(120);
    }
    return seiten.length;
  }

  it("rechnungen", async () => {
    await blaettern(
      "rechnungen",
      {},
      (a) => [{ total: (a as Antwort).total, eintraege: (a as { rechnungen: Antwort[] }).rechnungen }],
      (e) => e.nummer,
    );
    expect(await run("rechnungen", { limit: 50, offset: 50 })).toMatchObject({ anzahl: 120, total: 120, limit: 50, offset: 50 });
  });

  it("belege", async () => {
    await blaettern(
      "belege",
      { status: "gebucht" },
      (a) => [{ total: (a as Antwort).total, eintraege: (a as { belege: Antwort[] }).belege }],
      (e) => e.link,
    );
    expect(await run("belege", { status: "gebucht", limit: 50, offset: 100 })).toMatchObject({ anzahl: 120, total: 120, limit: 50, offset: 100 });
  });

  it("offene_posten: ein offset für Forderungen und Verbindlichkeiten, total je Liste", async () => {
    type Posten = { forderungen: { total: number; posten: Antwort[] }; verbindlichkeiten: { total: number; posten: Antwort[] } };
    await blaettern(
      "offene_posten",
      {},
      (a) => [
        { total: (a as Posten).forderungen.total, eintraege: (a as Posten).forderungen.posten },
        { total: (a as Posten).verbindlichkeiten.total, eintraege: (a as Posten).verbindlichkeiten.posten },
      ],
      (e) => e.brutto,
    );
    expect(await run("offene_posten", { limit: 50, offset: 50 })).toMatchObject({
      limit: 50,
      offset: 50,
      forderungen: { anzahl: 120 },
      verbindlichkeiten: { anzahl: 120 },
    });
  });

  it("offene_posten: die Verbindlichkeiten bleiben in fester Reihenfolge, auch wenn Postgres die Zeilen anders liefert", async () => {
    // openPayables fragt ohne ORDER BY; bei gleicher Fälligkeit und Nummer entschied bisher die Lage der Zeilen in der
    // Tabelle. CLUSTER legt sie zwischen zwei Seiten neu ab, wie es nach Änderungen und VACUUM auch von selbst geschieht.
    type Posten = { verbindlichkeiten: { posten: Antwort[] } };
    const lesen = async (offset: number) => ((await run("offene_posten", { limit: 50, offset })) as Posten).verbindlichkeiten.posten;
    const erste = await lesen(0);
    await sql`cluster documents using documents_pkey`;
    const rest = [...(await lesen(50)), ...(await lesen(100))];
    expect(new Set([...erste, ...rest].map((p) => p.brutto)).size).toBe(120);
  });

  it("bankumsaetze_ohne_zuordnung: ein offset für alle Konten, total je Konto", async () => {
    type Konto = { konto: string; anzahl: number; total: number; limit: number; offset: number; umsaetze: Antwort[] };
    await blaettern(
      "bankumsaetze_ohne_zuordnung",
      {},
      (a) => (a as Konto[]).map((k) => ({ total: k.total, eintraege: k.umsaetze })),
      (e) => e.verwendungszweck,
    );
    const konten = (await run("bankumsaetze_ohne_zuordnung", { limit: 50, offset: 100 })) as Konto[];
    expect(konten.map((k) => [k.konto, k.anzahl, k.limit, k.offset])).toEqual([
      ["Girokonto", 120, 50, 100],
      ["Tagesgeld", 120, 50, 100],
    ]);
  });

  it("bankumsaetze_ohne_zuordnung: total zählt beim Zahlungsdienstleister die gelieferten Zeilen, anzahl Zahlung und Gebühr als eine", async () => {
    const [konto] =
      await sql`insert into bank_accounts (name, purpose, provider, ledger_index) values ('Zahldienst', 'zahlungsdienstleister', 'paypal', 1) returning id`;
    const [imp] = await sql`insert into bank_imports (bank_account_id, filename, sha256, format, added, skipped)
      values (${konto!.id}, 'zahldienst.csv', 'sha-zahldienst', 'csv', 2, 0) returning id`;
    await sql`insert into bank_transactions (bank_account_id, import_id, booking_date, amount, counterparty_name, purpose, bank_reference, dedup_hash) values
      (${konto!.id}, ${imp!.id}, '2026-10-21', 5000, 'Kundin', 'Zahlung', 'txn_1', 'zahldienst-1'),
      (${konto!.id}, ${imp!.id}, '2026-10-21', -175, 'Zahldienst', 'Gebühr', 'txn_1-gebuehr', 'zahldienst-2')`;
    type Konto = { konto: string; anzahl: number; total: number; umsaetze: unknown[] };
    const lesen = async (offset: number) =>
      ((await run("bankumsaetze_ohne_zuordnung", { limit: 1, offset })) as Konto[]).find((k) => k.konto === "Zahldienst")!;
    const seiten = [await lesen(0), await lesen(1), await lesen(2)];
    expect(seiten.map((k) => [k.anzahl, k.total, k.umsaetze.length])).toEqual([
      [1, 2, 1],
      [1, 2, 1],
      [1, 2, 0],
    ]);
  });

  it("archiv_auftragsdokumente", async () => {
    await blaettern(
      "archiv_auftragsdokumente",
      { jahr: 2025, suche: "" },
      (a) => [{ total: (a as Antwort).total, eintraege: (a as { dokumente: Antwort[] }).dokumente }],
      (e) => e.id,
    );
    expect(await run("archiv_auftragsdokumente", { jahr: 2025, suche: "", limit: 50, offset: 0 })).toMatchObject({
      gesamt: 120,
      total: 120,
      limit: 50,
      offset: 0,
    });
  });

  it("lexoffice_belege: gekuerzt, solange hinter der Seite noch etwas kommt", async () => {
    const args = { zeitraum: "2025", richtung: "alle", suche: "", nachZahlung: false };
    await blaettern(
      "lexoffice_belege",
      args,
      (a) => [{ total: (a as Antwort).total, eintraege: (a as { belege: Antwort[] }).belege }],
      (e) => e.id,
    );
    expect(await run("lexoffice_belege", { ...args, limit: 50, offset: 50 })).toMatchObject({ anzahl: 120, total: 120, limit: 50, offset: 50, gekuerzt: true });
    expect(await run("lexoffice_belege", { ...args, limit: 50, offset: 100 })).toMatchObject({ gekuerzt: false });
  });

  it("lexoffice_buchungen: gekuerzt, solange hinter der Seite noch etwas kommt", async () => {
    const args = { zeitraum: "2025", konto: "", ohneBeleg: false };
    await blaettern(
      "lexoffice_buchungen",
      args,
      (a) => [{ total: (a as Antwort).total, eintraege: (a as { buchungen: Antwort[] }).buchungen }],
      (e) => e.betrag,
    );
    expect(await run("lexoffice_buchungen", { ...args, limit: 50, offset: 50 })).toMatchObject({
      anzahl: 120,
      total: 120,
      limit: 50,
      offset: 50,
      gekuerzt: true,
    });
    expect(await run("lexoffice_buchungen", { ...args, limit: 50, offset: 100 })).toMatchObject({ gekuerzt: false });
  });

  it("ohne offset beginnt die Liste vorn; ein negativer offset ist ein Eingabefehler", async () => {
    await mcp.setMcpEnabled(actor, true);
    const { token } = await mcp.createMcpToken({ name: "Claude Code", days: 30 }, new Date(), actor);
    const call = async (args: Record<string, unknown>) => {
      const response = await server.handleMcpRequest(
        new Request("http://localhost:3000/api/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rechnungen", arguments: args } }),
        }),
      );
      return ((await response.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
    };
    const erste = await call({});
    expect(erste.isError).toBeFalsy();
    expect(JSON.parse(erste.content[0]!.text)).toMatchObject({ total: 120, limit: 50, offset: 0 });
    expect((await call({ offset: -1 })).isError).toBe(true);
  });
});
