import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Dauerbelege in Wochen (#1691): Reinigung wöchentlich, alle 2 Wochen und alle 4 Wochen. Mehrere Termine fallen in einen
 * Monat; jeder bekommt einen eigenen Beleg, weil die Periode bei Wochen der Termin selbst ist.
 */

const vertrag = () => ({ bytes: new TextEncoder().encode("%PDF-1.4\n% Reinigungsvertrag\n%%EOF\n"), filename: "reinigung.pdf" });

describe.skipIf(!testDatabaseUrl)("Dauerbelege in Wochen (Postgres, #1691)", () => {
  let dauer: typeof import("./dauerbelege.ts");
  let lauf: typeof import("./dauerbelege-lauf.ts");
  let sql: postgres.Sql;
  const actor = "test-user";

  beforeAll(async () => {
    sql = await setupTestDb();
    dauer = await import("./dauerbelege.ts");
    lauf = await import("./dauerbelege-lauf.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    await leeren(sql)`truncate document_amounts, documents, recurring_documents, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, versteuerung, kontenrahmen)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'BY', 'ist', 'SKR03')`;
  });

  const reinigung = (overrides: Partial<import("./dauerbelege.ts").DauerbelegInput> = {}) => ({
    name: "Büroreinigung",
    supplierName: "Blitzblank Reinigung GmbH",
    category: "sonstiges" as const,
    payment: "bank" as const,
    amounts: [{ taxRate: 1900 as const, net: 12_000, tax: 2_280 }],
    taxShown: true,
    recurrence: "P1W" as const,
    nextDate: "2026-12-21",
    endDate: null,
    ...overrides,
  });

  const belege = (id: string) =>
    sql`select document_date::text, recurring_period::text from documents where recurring_document_id = ${id} order by document_date`;

  it("wöchentlich: ein Beleg je Termin, auch mehrere im Monat und über den Jahreswechsel", async () => {
    const vorlage = await dauer.createDauerbeleg(actor, reinigung(), vertrag());
    expect(await lauf.runDueDauerbelege("2027-01-05")).toEqual({ created: 3, errors: [] });
    expect((await belege(vorlage.id)).map((r) => [r.document_date, r.recurring_period])).toEqual([
      ["2026-12-21", "2026-12-21"],
      ["2026-12-28", "2026-12-28"],
      ["2027-01-04", "2027-01-04"],
    ]);
    const [stand] = await sql`select next_date::text from recurring_documents where id = ${vorlage.id}`;
    expect(stand!.next_date).toBe("2027-01-11");
    // Ein zweiter Lauf legt nichts doppelt an
    expect(await lauf.runDueDauerbelege("2027-01-05")).toEqual({ created: 0, errors: [] });
  });

  it("alle 2 und 4 Wochen", async () => {
    const zwei = await dauer.createDauerbeleg(actor, reinigung({ recurrence: "P2W", nextDate: "2026-11-02" }), vertrag());
    const vier = await dauer.createDauerbeleg(actor, reinigung({ name: "Fensterreinigung", recurrence: "P4W", nextDate: "2026-11-02" }), vertrag());
    await lauf.runDueDauerbelege("2026-12-31");
    expect((await belege(zwei.id)).map((r) => r.document_date)).toEqual(["2026-11-02", "2026-11-16", "2026-11-30", "2026-12-14", "2026-12-28"]);
    expect((await belege(vier.id)).map((r) => r.document_date)).toEqual(["2026-11-02", "2026-11-30", "2026-12-28"]);
  });

  it("Wechsel von Wochen auf Monate nimmt den Ankertag vom nächsten Termin", async () => {
    const vorlage = await dauer.createDauerbeleg(actor, reinigung({ recurrence: "P2W", nextDate: "2026-11-23" }), vertrag());
    await lauf.runDueDauerbelege("2026-11-23");
    const monatlich = await dauer.updateDauerbeleg(actor, vorlage.id, reinigung({ recurrence: "P1M", nextDate: "2026-12-07" }), null);
    expect(monatlich).toMatchObject({ recurrence: "P1M", anchorDay: 7 });
  });

  it("lehnt ein unbekanntes Intervall ab", async () => {
    await expect(dauer.createDauerbeleg(actor, reinigung({ recurrence: "P3W" as "P1W" }), vertrag())).rejects.toThrow("Intervall nicht unterstützt.");
  });
});
