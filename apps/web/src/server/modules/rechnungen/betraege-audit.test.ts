import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { kleinunternehmerStand } from "../auswertungen/test-umsatz-stand.ts";

/*
 * Positionen und Steuerzeilen einer Rechnung im Audit-Log (#1978): Jede Änderung an invoice_lines und invoice_taxes steht
 * mit Akteur in der Kette, auch am Entwurf. Festschreiben, Storno und Siegel bleiben wie bisher, die Integritätsprüfung
 * (Kette, Sollbestand, Siegel) ohne Befund.
 */
describe.skipIf(!testDatabaseUrl)("Positionen und Steuerzeilen einer Rechnung im Audit-Log (Postgres)", () => {
  let invoices: typeof import("./index.ts");
  let contacts: typeof import("../stammdaten/contacts.ts");
  let integrity: typeof import("../auswertungen/integrity.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  let contactId: string;

  const line = (unitPrice: number, taxRate: 1900 | 700 = 1900) => ({
    description: "Frontend-Entwicklung",
    quantity: 1000,
    unit: "Std." as const,
    unitPrice,
    taxRate,
  });

  const draft = (lines: ReturnType<typeof line>[]) => ({
    contactId,
    issueDate: "2026-10-02",
    serviceFrom: null,
    serviceTo: null,
    paymentTermDays: 14,
    format: "zugferd" as const,
    note: "",
    lines,
  });

  beforeAll(async () => {
    sql = await setupTestDb();
    invoices = await import("./index.ts");
    contacts = await import("../stammdaten/contacts.ts");
    integrity = await import("../auswertungen/integrity.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  async function reset(kontenrahmen: "SKR03" | "SKR04", versteuerung: "ist" | "soll") {
    // Mit Siegeln und neuer Kette: Siegel früherer Fälle ohne ihre Rechnungen wären sonst ein Befund
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`truncate seals, audit_log, audit_chain, allocations, journal_lines, journal_entries, invoice_taxes, invoice_lines, invoices,
        invoice_number_counters, contact_versions, contacts, company cascade`;
      await tx`insert into audit_chain (id, seq, hash) values (1, 0, haben_audit_genesis())`;
    });
    await sql`insert into company (id, name, strasse, plz, ort, email, telefon, steuernummer, ust_id, bundesland, iban, bic, bank, versteuerung, kontenrahmen)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '+49 941 123456',
              '198/113/10010', 'DE123456789', 'BY', 'DE89370400440532013000', 'COBADEFFXXX', 'Commerzbank', ${versteuerung}, ${kontenrahmen})`;
    contactId = (
      await contacts.createContact(actor, {
        kundennummer: "10001",
        name: "Nordwerk Software GmbH",
        strasse: "Hafenstraße 5",
        plz: "20457",
        ort: "Hamburg",
        land: "DE",
        email: "buchhaltung@nordwerk.example",
        ustId: "",
        iban: "",
        leitwegId: "",
        defaultFormat: null,
      })
    ).id;
  }

  /** Einträge einer Tabelle zu dieser Rechnung in der Reihenfolge der Kette */
  async function eintraege(table: "invoice_lines" | "invoice_taxes", id: string) {
    return sql<{ action: string; actor: string | null; row_id: string | null; wert: string; rate: string | null }[]>`
      select action, actor, row_id, coalesce(new_value, old_value) ->> ${table === "invoice_lines" ? "net" : "base"} as wert,
             coalesce(new_value, old_value) ->> 'rate' as rate
        from audit_log where table_name = ${table} and coalesce(new_value, old_value) ->> 'invoice_id' = ${id} order by seq`;
  }

  const befunde = async () => (await integrity.checkIntegrity()).problems;

  it("Entwurf: geänderte Positionen und Steuerzeilen stehen mit Akteur im Audit-Log", async () => {
    await reset("SKR04", "ist");
    const { id } = await invoices.createDraft(actor, draft([line(10_000)]));
    const [position] = await sql<{ id: string }[]>`select id from invoice_lines where invoice_id = ${id}`;
    expect(await eintraege("invoice_lines", id)).toEqual([{ action: "INSERT", actor, row_id: position!.id, wert: "10000", rate: null }]);
    // invoice_taxes hat keine Spalte id, sondern den Schlüssel (invoice_id, rate): haben_audit findet weder id noch year
    // und lässt row_id leer wie bei exchange_rates; welche Zeile es war, steht im Wert (invoice_id und rate)
    expect(await eintraege("invoice_taxes", id)).toEqual([{ action: "INSERT", actor, row_id: null, wert: "10000", rate: "1900" }]);

    await invoices.updateDraft(actor, id, draft([line(20_000), line(5_000, 700)]));
    expect((await eintraege("invoice_lines", id)).map((e) => [e.action, e.wert])).toEqual([
      ["INSERT", "10000"],
      ["DELETE", "10000"],
      ["INSERT", "20000"],
      ["INSERT", "5000"],
    ]);
    const steuern = await eintraege("invoice_taxes", id);
    expect(steuern.slice(0, 2).map((e) => [e.action, e.rate, e.wert])).toEqual([
      ["INSERT", "1900", "10000"],
      ["DELETE", "1900", "10000"],
    ]);
    // Die neuen Sätze in der Reihenfolge, in der die Berechnung sie liefert
    expect(
      steuern
        .slice(2)
        .map((e) => [e.action, e.rate, e.wert])
        .sort(),
    ).toEqual([
      ["INSERT", "1900", "20000"],
      ["INSERT", "700", "5000"],
    ]);
    expect(steuern.every((e) => e.actor === actor)).toBe(true);
    expect(await befunde()).toEqual([]);
  });

  it("Löschen eines Entwurfs: Positionen und Steuerzeilen gehen über ON DELETE CASCADE mit DELETE ins Audit-Log", async () => {
    await reset("SKR03", "soll");
    const { id } = await invoices.createDraft(actor, draft([line(10_000), line(3_000, 700)]));
    await invoices.deleteDraft(actor, id);
    expect((await eintraege("invoice_lines", id)).map((e) => [e.action, e.actor])).toEqual([
      ["INSERT", actor],
      ["INSERT", actor],
      ["DELETE", actor],
      ["DELETE", actor],
    ]);
    expect((await eintraege("invoice_taxes", id)).map((e) => e.action)).toEqual(["INSERT", "INSERT", "DELETE", "DELETE"]);
    expect(await befunde()).toEqual([]);
  });

  for (const [kontenrahmen, versteuerung] of [
    ["SKR03", "soll"],
    ["SKR04", "ist"],
  ] as const) {
    it(`festgeschrieben und storniert (${kontenrahmen}, ${versteuerung}): Siegel gültig, eine abgelehnte Änderung schreibt nichts ins Audit-Log`, async () => {
      await reset(kontenrahmen, versteuerung);
      const { id } = await invoices.createDraft(actor, draft([line(10_000), line(3_000, 700)]));
      await invoices.finalizeInvoice(actor, id, kleinunternehmerStand);

      const siegel = async (rowId: string) =>
        (
          await sql<{ digest: string; berechnet: string }[]>`
            select digest, haben_seal_digest(table_name, row_id, columns) as berechnet from seals where table_name = 'invoices' and row_id = ${rowId}`
        )[0];
      const vorher = await siegel(id);
      expect(vorher!.berechnet).toBe(vorher!.digest);

      const anzahl = async () => (await eintraege("invoice_lines", id)).length + (await eintraege("invoice_taxes", id)).length;
      const bisher = await anzahl();
      await expect(sql`update invoice_lines set net = 1 where invoice_id = ${id}`).rejects.toThrow(/festgeschrieben/);
      await expect(sql`update invoice_taxes set tax = 1 where invoice_id = ${id}`).rejects.toThrow(/festgeschrieben/);
      await expect(sql`delete from invoice_taxes where invoice_id = ${id}`).rejects.toThrow(/festgeschrieben/);
      expect(await anzahl()).toBe(bisher);
      expect(await siegel(id)).toEqual(vorher);

      // Das Storno legt seinen Entwurf samt Positionen und Steuerzeilen in derselben Transaktion an und schreibt ihn fest
      const storno = await invoices.cancelInvoice(actor, id, "2026-10-05");
      expect(storno.status).toBe("final");
      expect((await eintraege("invoice_taxes", storno.id)).map((e) => e.action)).toEqual(["INSERT", "INSERT"]);
      const stornoSiegel = await siegel(storno.id);
      expect(stornoSiegel!.berechnet).toBe(stornoSiegel!.digest);
      expect(await befunde()).toEqual([]);
    }, 60_000);
  }
});
