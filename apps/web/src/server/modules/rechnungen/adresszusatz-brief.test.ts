import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Neuer Brief zu einem festgeschriebenen Beleg (Mahnung, Auftragsbestätigung, Lieferschein, Mail): withCurrentBuyer
 * nimmt Name und Anschrift des Kontakts von heute. Der Adresszusatz (#914) gehört zur Anschrift und kommt mit, sonst
 * mischte der Empfängerblock die neue Straße mit dem alten Zusatz. Daten erfunden.
 */
describe.skipIf(!testDatabaseUrl)("Adresszusatz im neuen Brief (Postgres, #914)", () => {
  let sql: postgres.Sql;
  let contacts: typeof import("../stammdaten/contacts.ts");
  let doc: typeof import("./invoice-document.ts");
  let db: typeof import("../../db/index.ts").db;
  const actor = "test-user";
  const input = (extra: Record<string, unknown> = {}) => ({
    kundennummer: "",
    name: "Nordwerk GmbH",
    strasse: "Hafenweg 3",
    plz: "20457",
    ort: "Hamburg",
    land: "DE",
    email: "buchhaltung@nordwerk.example",
    ustId: "",
    iban: "",
    leitwegId: "",
    defaultFormat: null,
    ...extra,
  });

  beforeAll(async () => {
    sql = await setupTestDb();
    contacts = await import("../stammdaten/contacts.ts");
    doc = await import("./invoice-document.ts");
    db = (await import("../../db/index.ts")).db;
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    await leeren(sql)`truncate contact_versions, contacts cascade`;
  });

  const festgeschrieben = { name: "Nordwerk GmbH", adresszusatz: "Abteilung Einkauf", strasse: "Hafenweg 3", plz: "20457", ort: "Hamburg", land: "DE" };

  it("nimmt den heutigen Adresszusatz zur heutigen Straße", async () => {
    const { id } = await contacts.createContact(actor, input({ adresszusatz: "c/o Büro Süd", strasse: "Bergstraße 9", plz: "80331", ort: "München" }));
    const buyer = await doc.withCurrentBuyer(db, festgeschrieben, id);
    expect(buyer).toMatchObject({ strasse: "Bergstraße 9", adresszusatz: "c/o Büro Süd" });
  });

  it("lässt einen Zusatz weg, den der Kontakt heute nicht mehr hat", async () => {
    const { id } = await contacts.createContact(actor, input({ strasse: "Bergstraße 9", plz: "80331", ort: "München" }));
    const buyer = await doc.withCurrentBuyer(db, festgeschrieben, id);
    expect(buyer.strasse).toBe("Bergstraße 9");
    expect(buyer).not.toHaveProperty("adresszusatz");
  });
});
