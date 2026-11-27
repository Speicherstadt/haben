import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { kleinunternehmerStand } from "../auswertungen/test-umsatz-stand.ts";

/*
 * Anschrift am Kontakt (#914): Adresszusatz als eigenes Feld, in den Versionen und beim Festschreiben im Käufer der
 * Rechnung (PDF-Zeile und BT-51); die PLZ prüft der Server je Land, in Deutschland fünf Ziffern. Keine Buchung ändert
 * sich, deshalb ohne Unterschied nach Kontenrahmen und Versteuerung. Alle Daten sind erfunden.
 */
describe.skipIf(!testDatabaseUrl)("Anschrift am Kontakt (Postgres, #914)", () => {
  let sql: postgres.Sql;
  let contacts: typeof import("./contacts.ts");
  let invoices: typeof import("../rechnungen/index.ts");
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
    contacts = await import("./contacts.ts");
    invoices = await import("../rechnungen/index.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    await leeren(sql)`truncate invoice_lines, invoices, invoice_number_counters, contact_versions, contacts, journal_lines, journal_entries, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, ust_id, bundesland, iban, versteuerung, kontenrahmen)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010',
              'DE123456789', 'BY', 'DE89370400440532013000', 'ist', 'SKR03')`;
  });

  it("speichert den Adresszusatz und hält den alten Stand in den Versionen; ohne Angabe bleibt er leer", async () => {
    const created = await contacts.createContact(actor, input({ adresszusatz: "Abteilung Einkauf" }));
    expect(created.adresszusatz).toBe("Abteilung Einkauf");
    await contacts.updateContact(actor, created.id, input({ adresszusatz: "c/o Büro Nord" }));
    const [version] = await sql`select data from contact_versions where contact_id = ${created.id} and version = 1`;
    expect(version!.data).toMatchObject({ adresszusatz: "Abteilung Einkauf" });
    expect((await contacts.createContact(actor, input({ name: "Ohne Zusatz GmbH" }))).adresszusatz).toBe("");
  });

  it("prüft die PLZ je Land: in Deutschland fünf Ziffern am Feld plz, im Ausland frei", async () => {
    await expect(contacts.createContact(actor, input({ plz: "2045" }))).rejects.toMatchObject({
      message: "Eine deutsche PLZ hat fünf Ziffern, etwa 93047.",
      felder: ["plz"],
    });
    const nl = await contacts.createContact(actor, input({ plz: "1015 CJ", ort: "Amsterdam", land: "NL" }));
    expect(nl.plz).toBe("1015 CJ");
    await expect(contacts.updateContact(actor, nl.id, input({ plz: "1015 CJ" }))).rejects.toMatchObject({ felder: ["plz"] });
  });

  it("die Übernahme aus einer anderen Instanz nimmt eine alte PLZ, wie sie war", async () => {
    const { withActor } = await import("../../db/actor.ts");
    const alt = await withActor(actor, (tx) => contacts.insertContact(tx, input({ plz: "D-20457" })));
    expect(alt.plz).toBe("D-20457");
  });

  it("steht beim Festschreiben im Käufer und in der XML als BT-51; spätere Änderungen am Kontakt berühren die Rechnung nicht", async () => {
    const { id: contactId } = await contacts.createContact(actor, input({ adresszusatz: "Abteilung Einkauf" }));
    const draft = await invoices.createDraft(actor, {
      contactId,
      issueDate: "2026-09-05",
      serviceFrom: null,
      serviceTo: null,
      paymentTermDays: 14,
      format: "zugferd",
      note: "",
      lines: [{ description: "Leistungen August", quantity: 1000, unit: "Psch.", unitPrice: 100_000, taxRate: 1900 }],
    });
    const invoice = await invoices.finalizeInvoice(actor, draft.id, kleinunternehmerStand);
    expect(invoice.buyer?.adresszusatz).toBe("Abteilung Einkauf");
    expect(invoice.xml).toMatch(/<ram:LineOne>Hafenweg 3<\/ram:LineOne>\s*<ram:LineTwo>Abteilung Einkauf<\/ram:LineTwo>/);

    await contacts.updateContact(actor, contactId, input({ adresszusatz: "" }));
    expect((await invoices.getInvoice(draft.id))?.invoice.buyer?.adresszusatz).toBe("Abteilung Einkauf");
  });
});
