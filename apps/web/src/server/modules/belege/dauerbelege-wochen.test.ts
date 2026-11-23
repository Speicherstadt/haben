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

  it("Wechsel zwischen Wochen und Monaten nur ohne Belege, sonst kollidieren die Perioden (Review #1691)", async () => {
    // freitags: 25.12.2026 und 01.01.2027; der zweite Wochenbeleg hat die Periode 2027-01-01 wie ein Monatsbeleg im Januar
    const vorlage = await dauer.createDauerbeleg(actor, reinigung({ nextDate: "2026-12-25" }), vertrag());
    expect(await lauf.runDueDauerbelege("2027-01-01")).toEqual({ created: 2, errors: [] });
    await expect(dauer.updateDauerbeleg(actor, vorlage.id, reinigung({ recurrence: "P1M", nextDate: "2027-01-29" }), null)).rejects.toThrow(
      "Wochen und Monate lassen sich nicht mehr tauschen",
    );
    // Innerhalb der Wochen bleibt der Wechsel möglich
    expect(await dauer.updateDauerbeleg(actor, vorlage.id, reinigung({ recurrence: "P2W", nextDate: "2027-01-08" }), null)).toMatchObject({
      recurrence: "P2W",
    });
    // Ohne Belege geht auch der Wechsel auf Monate; der Ankertag kommt vom nächsten Termin
    const neu = await dauer.createDauerbeleg(actor, reinigung({ name: "Fenster", recurrence: "P2W", nextDate: "2027-03-05" }), vertrag());
    expect(await dauer.updateDauerbeleg(actor, neu.id, reinigung({ name: "Fenster", recurrence: "P1M", nextDate: "2027-03-31" }), null)).toMatchObject({
      recurrence: "P1M",
      anchorDay: 31,
    });
  });

  it("lehnt ein unbekanntes Intervall ab", async () => {
    await expect(dauer.createDauerbeleg(actor, reinigung({ recurrence: "P3W" as "P1W" }), vertrag())).rejects.toThrow("Intervall nicht unterstützt.");
  });
});
