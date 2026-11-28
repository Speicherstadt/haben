import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { kleinunternehmerStand } from "../auswertungen/test-umsatz-stand.ts";

/** Übernehmen aus dem Postfach (#660): Das Markieren läuft in der Transaktion, die bucht */
describe.skipIf(!testDatabaseUrl)("Ausgangsrechnung aus dem Postfach übernehmen (Postgres)", () => {
  let foreign: typeof import("./fremdrechnung.ts");
  let belege: typeof import("../belege/index.ts");
  let contacts: typeof import("../stammdaten/contacts.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  const pdf = new TextEncoder().encode("%PDF-1.7\n% Original aus dem Fremdsystem\n");

  beforeAll(async () => {
    sql = await setupTestDb();
    foreign = await import("./fremdrechnung.ts");
    belege = await import("../belege/index.ts");
    contacts = await import("../stammdaten/contacts.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  it("Verwerfen während des Übernehmens derselben Datei verklemmt sich nicht", async () => {
    await leeren(sql)`truncate inbox_outgoing, journal_lines, journal_entries, invoice_lines, invoices, contact_versions, contacts, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, telefon, steuernummer, ust_id, bundesland, iban, versteuerung, kontenrahmen,
                                   payment_term_days, skonto)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '+49 941 1', '198/113/10010',
              'DE123456789', 'BY', 'DE89370400440532013000', 'soll', 'SKR03', 14, '[]'::jsonb)`;
    const { id: contactId } = await contacts.createContact(actor, {
      kundennummer: "",
      name: "Bäckerei Kranz",
      strasse: "Marktplatz 3",
      plz: "93047",
      ort: "Regensburg",
      land: "DE",
      email: "",
      ustId: "",
      iban: "",
      leitwegId: "",
      defaultFormat: null,
    });
    const [eintrag] = await sql`insert into inbox_outgoing (sha256, filename, mime_type, size, sender, subject)
      values (${"a".repeat(64)}, 'VK-1.pdf', 'application/pdf', 1, 'shop@example.com', 'VK-1') returning id`;

    let verwerfen: Promise<PromiseSettledResult<void>[]> | undefined;
    const uebernehmen = foreign.adoptForeignInvoice(
      actor,
      { number: "VK-1", issueDate: "2026-09-25", dueDate: "2026-10-09", contactId, taxes: [{ rate: 1900, net: 10_000, tax: 1_900 }] },
      pdf,
      kleinunternehmerStand,
      null,
      async (tx, invoiceId) => {
        // Gebucht ist schon, markiert noch nicht: Jetzt verwirft ein zweites Fenster dieselbe Datei
        verwerfen = Promise.allSettled([belege.discardOutgoing("zweites-fenster", eintrag!.id)]);
        for (let i = 0; i < 500; i++) {
          const [w] = await sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`;
          if (w!.n > 0) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        await belege.markOutgoingAdopted(actor, eintrag!.id, invoiceId, tx);
      },
    );
    const [erst] = await Promise.allSettled([uebernehmen]);
    const [zweit] = await verwerfen!;
    const grund = (r: PromiseSettledResult<unknown>) =>
      r.status === "fulfilled" ? "ok" : String((r.reason as { cause?: Error }).cause?.message ?? (r.reason as Error).message);
    expect([grund(erst!), grund(zweit!)]).toEqual(["ok", "ok"]);
    const [stand] = await sql`select status from inbox_outgoing where id = ${eintrag!.id}`;
    expect(stand!.status).toBe("uebernommen");
  }, 30_000);
});
