import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Beträge eines Belegs im Audit-Log (#1978): Jede Änderung an document_amounts steht mit Akteur in der Kette, auch am
 * Entwurf. Buchen und Siegel bleiben wie bisher, die Integritätsprüfung (Kette, Sollbestand, Siegel) ohne Befund.
 */
describe.skipIf(!testDatabaseUrl)("Beträge eines Belegs im Audit-Log (Postgres)", () => {
  let documents: typeof import("./documents.ts");
  let integrity: typeof import("../auswertungen/integrity.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  let fileSeq = 0;

  beforeAll(async () => {
    sql = await setupTestDb();
    documents = await import("./documents.ts");
    integrity = await import("../auswertungen/integrity.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function reset(kontenrahmen: "SKR03" | "SKR04", versteuerung: "ist" | "soll") {
    // Mit Siegeln und neuer Kette: Siegel früherer Fälle ohne ihre Belege wären sonst ein Befund
    await leeren(sql)`truncate seals, audit_log, audit_chain, document_cancellations, vat_returns, allocations, cash_entries, asset_depreciations, assets,
      journal_lines, journal_entries, document_splits, document_amounts, documents, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, versteuerung, kontenrahmen)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'BY', ${versteuerung}, ${kontenrahmen})`;
  }

  type Betrag = { taxRate: 1900 | 700 | 0; net: number; tax: number };

  async function upload(): Promise<string> {
    fileSeq++;
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, fileSeq % 256, Math.floor(fileSeq / 256), 19, 78]);
    return (await documents.uploadDocument(actor, { bytes, filename: `audit-${fileSeq}.jpg` })).id;
  }

  async function save(id: string, amounts: Betrag[]) {
    await documents.updateDocument(actor, id, {
      supplierName: "Bürohaus Nord GmbH",
      supplierUstId: "",
      invoiceNumber: `BN-${fileSeq}`,
      documentDate: "2026-09-15",
      dueDate: null,
      category: "buero",
      payment: "bank",
      note: "",
      privateShare: 0,
      reverseCharge: null,
      currency: "EUR",
      exchangeRate: null,
      amounts,
      splits: [],
    });
  }

  /** Einträge zu den Beträgen dieses Belegs in der Reihenfolge der Kette */
  async function eintraege(id: string) {
    return sql<{ action: string; actor: string | null; row_id: string | null; net: number }[]>`
      select action, actor, row_id, coalesce(new_value, old_value) ->> 'net' as net from audit_log
       where table_name = 'document_amounts' and coalesce(new_value, old_value) ->> 'document_id' = ${id} order by seq`;
  }

  /** Kette, Siegel und Sollbestand: Befunde und Hinweise der Prüfung (ein Trigger außerhalb des Sollbestands ist ein Hinweis) */
  const befunde = async () => {
    const { problems, triggerHints } = await integrity.checkIntegrity();
    return [...problems, ...triggerHints];
  };

  it("Entwurf: angelegte, ersetzte und gelöschte Beträge stehen mit Akteur und Zeilenkennung im Audit-Log", async () => {
    await reset("SKR04", "ist");
    const id = await upload();
    await save(id, [{ taxRate: 1900, net: 10_000, tax: 1_900 }]);
    const [erster] = await sql<{ id: string }[]>`select id from document_amounts where document_id = ${id}`;
    expect(await eintraege(id)).toEqual([{ action: "INSERT", actor, row_id: erster!.id, net: "10000" }]);

    await save(id, [
      { taxRate: 1900, net: 20_000, tax: 3_800 },
      { taxRate: 700, net: 1_000, tax: 70 },
    ]);
    const nachher = await eintraege(id);
    expect(nachher.map((e) => [e.action, e.net])).toEqual([
      ["INSERT", "10000"],
      ["DELETE", "10000"],
      ["INSERT", "20000"],
      ["INSERT", "1000"],
    ]);
    expect(nachher.every((e) => e.actor === actor && e.row_id !== null)).toBe(true);
    expect(await befunde()).toEqual([]);
  });

  it("Löschen eines Entwurfs: Die Beträge gehen über ON DELETE CASCADE mit DELETE ins Audit-Log", async () => {
    await reset("SKR03", "soll");
    const id = await upload();
    await save(id, [
      { taxRate: 1900, net: 5_000, tax: 950 },
      { taxRate: 700, net: 2_000, tax: 140 },
    ]);
    await documents.deleteDocument(actor, id);
    expect((await eintraege(id)).map((e) => [e.action, e.actor])).toEqual([
      ["INSERT", actor],
      ["INSERT", actor],
      ["DELETE", actor],
      ["DELETE", actor],
    ]);
    expect(await befunde()).toEqual([]);
  });

  for (const [kontenrahmen, versteuerung] of [
    ["SKR03", "ist"],
    ["SKR04", "soll"],
  ] as const) {
    it(`gebucht (${kontenrahmen}, ${versteuerung}): Siegel deckt die Beträge, eine abgelehnte Änderung schreibt nichts ins Audit-Log`, async () => {
      await reset(kontenrahmen, versteuerung);
      const id = await upload();
      await save(id, [{ taxRate: 1900, net: 17_000, tax: 3_230 }]);
      await documents.bookDocument(actor, id);

      const [siegel] = await sql<{ digest: string; columns: Record<string, unknown> }[]>`
        select digest, columns from seals where table_name = 'documents' and row_id = ${id}`;
      expect(Object.keys(siegel!.columns)).toContain("document_amounts");
      const digest = async () =>
        (
          await sql<{ d: string }[]>`select haben_seal_digest(table_name, row_id, columns) as d from seals where table_name = 'documents' and row_id = ${id}`
        )[0]!.d;
      expect(await digest()).toBe(siegel!.digest);
      // Beim Buchen hält Haben den angewandten Vorsteueranteil an jedem Betrag fest, vor dem Siegel
      const [buchung] = await sql<{ seal: number; amount: number }[]>`
        select (select seq from audit_log where table_name = 'seals' and new_value ->> 'row_id' = ${id})::int as seal,
               (select max(seq) from audit_log where table_name = 'document_amounts' and new_value ->> 'document_id' = ${id})::int as amount`;
      expect(buchung!.amount).toBeLessThan(buchung!.seal);

      const vorher = (await eintraege(id)).length;
      await expect(sql`update document_amounts set net = 1 where document_id = ${id}`).rejects.toThrow(/gebucht/);
      await expect(sql`delete from document_amounts where document_id = ${id}`).rejects.toThrow(/gebucht/);
      expect(await eintraege(id)).toHaveLength(vorher);
      expect(await digest()).toBe(siegel!.digest);
      expect(await befunde()).toEqual([]);
    });
  }
});
