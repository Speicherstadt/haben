import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

describe.skipIf(!testDatabaseUrl)("POST /rechnungen/{id}/festschreiben mit Recht je Quelle (#1918)", () => {
  let api: typeof import("./index.ts");
  let mcp: typeof import("../mcp/index.ts");
  let rechnungen: typeof import("../rechnungen/index.ts");
  let contacts: typeof import("../stammdaten/contacts.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  let contactId: string;

  beforeAll(async () => {
    sql = await setupTestDb();
    await sql`insert into "user"(id,name,email,role) values (${actor}, 'Testinhaber', 'inhaber@example.de', 'inhaber') on conflict do nothing`;
    api = await import("./index.ts");
    mcp = await import("../mcp/index.ts");
    rechnungen = await import("../rechnungen/index.ts");
    contacts = await import("../stammdaten/contacts.ts");
  }, 30_000);
  afterAll(async () => {
    await sql?.end();
  });
  beforeEach(async () => {
    await leeren(sql)`truncate mcp_calls, mcp_tokens, mail_log, journal_lines, journal_entries, invoice_lines, invoice_taxes, invoices,
      invoice_number_counters, contact_versions, contacts, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, iban, bic, bank, kleinunternehmer)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'BY',
              'DE89370400440532013000', 'COBADEFFXXX', 'Commerzbank', true)`;
    await mcp.setMcpEnabled(actor, true);
    contactId = (
      await contacts.createContact(actor, {
        name: "Erika Käuferin",
        strasse: "Hafenstraße 5",
        plz: "20457",
        ort: "Hamburg",
        land: "DE",
        email: "",
        ustId: "",
        iban: "",
        leitwegId: "",
        defaultFormat: null,
      } as never)
    ).id;
  }, 30_000);

  async function draft(externalSource: string, externalId: string) {
    const input = rechnungen.draftSchema.parse({
      contactId,
      issueDate: "2026-09-01",
      serviceFrom: "2026-09-01",
      serviceTo: null,
      paymentTermDays: 0,
      paymentMethod: "bereits_bezahlt",
      paidVia: "eBay",
      paidOn: "2026-09-01",
      format: "zugferd",
      note: "",
      taxTreatment: "kleinunternehmer",
      priceMode: "brutto",
      lines: [{ description: "Steuer-Software 2026", quantity: 1000, unit: "Stk.", unitPrice: 1_990, taxRate: 0 }],
    });
    return (await rechnungen.createDraftForReference(actor, input, { externalSource, externalId })).invoice;
  }

  const post = (token: string, id: string, body: unknown = {}) =>
    api.handleApiRequest(
      new Request(`http://localhost:3000/api/v1/rechnungen/${id}/festschreiben`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    );

  it("das Recht gilt nur mit einer Quelle, aus der es schon Rechnungen gibt", async () => {
    await expect(mcp.createMcpToken({ name: "eBay", days: 365, scopes: ["rechnungen:festschreiben"] }, new Date(), actor)).rejects.toThrow(/Quelle wählen/);
    await expect(
      mcp.createMcpToken({ name: "eBay", days: 365, scopes: ["rechnungen:festschreiben"], finalizeSource: "ebay" }, new Date(), actor),
    ).rejects.toThrow(/noch keine Rechnungen/);
    await draft("ebay", "1");
    const { id } = await mcp.createMcpToken({ name: "eBay", days: 365, scopes: ["rechnungen:festschreiben"], finalizeSource: "ebay" }, new Date(), actor);
    // Ohne das Recht bleibt keine Quelle am Token hängen
    await mcp.createMcpToken({ name: "Shop", days: 30, scopes: ["rechnungen:entwuerfe"], finalizeSource: "ebay" }, new Date(), actor);
    const tokens = await mcp.listMcpTokens(new Date(), actor);
    expect(tokens.map((t) => [t.name, t.finalizeSource]).sort()).toEqual([
      ["Shop", null],
      ["eBay", "ebay"],
    ]);
    expect(tokens.find((t) => t.id === id)?.scopes).toEqual(["rechnungen:festschreiben"]);
  });

  it("schreibt fest und antwortet mit der Rechnung; fremde Quelle 403, ohne Recht 403", async () => {
    const ebay = await draft("ebay", "12-34567-89012");
    const etsy = await draft("etsy", "4711");
    const { token } = await mcp.createMcpToken({ name: "eBay", days: 365, scopes: ["rechnungen:festschreiben"], finalizeSource: "ebay" }, new Date(), actor);
    const { token: entwuerfe } = await mcp.createMcpToken({ name: "Shop", days: 30, scopes: ["rechnungen:entwuerfe"] }, new Date(), actor);

    expect((await post(entwuerfe, ebay.id)).status).toBe(403);
    const fremd = await post(token, etsy.id);
    expect(fremd.status).toBe(403);
    expect(await fremd.json()).toMatchObject({ error: { code: "forbidden", message: expect.stringMatching(/„ebay“/) } });

    const response = await post(token, ebay.id);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ id: ebay.id, status: "final", externalSource: "ebay", festgeschrieben: true, versand: { status: "nicht_verlangt" } });
    expect(body.number).toBeTruthy();
    expect(await (await post(token, ebay.id)).json()).toMatchObject({ number: body.number, festgeschrieben: false });
    // Das Recht schließt Lesen ein
    const read = await api.handleApiRequest(
      new Request(`http://localhost:3000/api/v1/rechnungen/${ebay.id}`, { headers: { Authorization: `Bearer ${token}` } }),
    );
    expect(read.status).toBe(200);
  });

  it("mit senden ohne E-Mail-Adresse 422, und der Entwurf bleibt Entwurf", async () => {
    const ebay = await draft("ebay", "12-1");
    const { token } = await mcp.createMcpToken({ name: "eBay", days: 365, scopes: ["rechnungen:festschreiben"], finalizeSource: "ebay" }, new Date(), actor);
    const response = await post(token, ebay.id, { senden: true });
    expect(response.status).toBe(422);
    expect((await rechnungen.getInvoice(ebay.id))!.invoice.status).toBe("draft");
    expect((await post(token, ebay.id, { senden: "ja" })).status).toBe(400);
  });
});
