import nodemailer from "nodemailer";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { kleinunternehmerStand } from "../auswertungen/test-umsatz-stand.ts";
import type { UmsatzStand } from "./umsatzgrenze.ts";

describe.skipIf(!testDatabaseUrl)("Entwürfe einer externen Quelle festschreiben und versenden (#1918)", () => {
  let rechnungen: typeof import("./index.ts");
  let external: typeof import("./external-finalize.ts");
  let mail: typeof import("../mail/mail.ts");
  let contacts: typeof import("../stammdaten/contacts.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  const apiActor = "api:00000000-0000-0000-0000-000000000001:eBay";
  const sent: { to: string; subject: string }[] = [];
  let mailFails = false;
  let contactId: string;

  beforeAll(async () => {
    sql = await setupTestDb();
    rechnungen = await import("./index.ts");
    external = await import("./external-finalize.ts");
    mail = await import("../mail/mail.ts");
    contacts = await import("../stammdaten/contacts.ts");
    mail.setMailTransportForTests(() => {
      const transport = nodemailer.createTransport({ jsonTransport: true });
      return {
        sendMail: async (message: { to: string; subject: string }) => {
          if (mailFails) throw new Error("Postfach voll");
          sent.push(message);
          return transport.sendMail(message);
        },
      } as unknown as ReturnType<typeof nodemailer.createTransport>;
    });
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    sent.length = 0;
    mailFails = false;
    await leeren(sql)`truncate mail_log, mail_settings, journal_lines, journal_entries, invoice_lines, invoice_taxes, invoices,
      invoice_number_counters, contact_versions, contacts, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, iban, bic, bank, kleinunternehmer)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'BY',
              'DE89370400440532013000', 'COBADEFFXXX', 'Commerzbank', true)`;
    contactId = (
      await contacts.createContact(actor, {
        name: "Erika Käuferin",
        strasse: "Hafenstraße 5",
        plz: "20457",
        ort: "Hamburg",
        land: "DE",
        email: "abc@members.ebay.com",
        ustId: "",
        iban: "",
        leitwegId: "",
        defaultFormat: null,
      } as never)
    ).id;
  }, 30_000);

  async function ebayDraft(overrides: Record<string, unknown> = {}, reference = { externalSource: "ebay", externalId: "12-34567-89012" }) {
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
      ...overrides,
    });
    return (await rechnungen.createDraftForReference(actor, input, reference)).invoice;
  }

  const run = (id: string, senden = false, umsatzStand: UmsatzStand = kleinunternehmerStand) =>
    external.finalizeExternalDraft(apiActor, id, { source: "ebay", senden, umsatzStand });

  const status = async (id: string) => (await rechnungen.getInvoice(id))!.invoice.status;

  async function mailSettings() {
    await mail.saveMailSettings(actor, {
      host: "smtp.example.com",
      port: 465,
      secure: true,
      username: "max",
      password: "geheim",
      fromAddress: "rechnung@testfirma.example",
      reminderTo: "max@testfirma.example",
      remindersEnabled: false,
      reminderDays: [],
    });
  }

  it("schreibt einen Entwurf der eigenen Quelle fest; ein zweiter Aufruf liefert dieselbe Rechnung ohne neue Nummer", async () => {
    const draft = await ebayDraft();
    const first = await run(draft.id);
    expect(first).toMatchObject({ ok: true, finalized: true, versand: { status: "nicht_verlangt" } });
    const number = first.ok ? first.invoice.number : null;
    expect(number).toBeTruthy();
    const second = await run(draft.id);
    expect(second).toMatchObject({ ok: true, finalized: false, invoice: { number } });
    expect(await sql`select actor from audit_log where table_name = 'invoices' and row_id = ${draft.id} order by id desc limit 1`).toEqual([
      { actor: apiActor },
    ]);
  });

  it("fasst keine Entwürfe einer anderen Quelle und keine ohne externe Referenz an", async () => {
    const etsy = await ebayDraft({}, { externalSource: "etsy", externalId: "4711" });
    expect(await run(etsy.id)).toMatchObject({ ok: false, code: "forbidden" });
    const manual = await rechnungen.createDraft(actor, rechnungen.draftSchema.parse({ ...(await rechnungen.getInvoice(etsy.id))!.invoice, lines: [] }));
    expect(await run(manual.id)).toMatchObject({ ok: false, code: "unprocessable" });
    expect(await status(etsy.id)).toBe("draft");
  });

  it("verlangt „Bereits bezahlt“ und meldet die Hinweise des Editors, ohne etwas zu schreiben", async () => {
    const offen = await ebayDraft(
      { paymentMethod: "ueberweisung", paidVia: null, paidOn: null, paymentTermDays: 14 },
      { externalSource: "ebay", externalId: "1" },
    );
    expect(await run(offen.id)).toMatchObject({ ok: false, code: "unprocessable", message: expect.stringMatching(/Bereits bezahlt/) });
    const ohnePosition = await ebayDraft({ lines: [] }, { externalSource: "ebay", externalId: "2" });
    expect(await run(ohnePosition.id)).toMatchObject({ ok: false, code: "unprocessable", issues: ["Keine Positionen", "Gesamtbetrag muss positiv sein"] });
    expect([await status(offen.id), await status(ohnePosition.id)]).toEqual(["draft", "draft"]);
  });

  it("schreibt nicht fest, wenn die Rechnung die Kleinunternehmergrenze überschreiten könnte", async () => {
    const draft = await ebayDraft();
    const kurzVorDerGrenze: UmsatzStand = async () => ({
      aktuell: { netto: 99_990_00 },
      vorjahr: { netto: 0 },
      jahresgrenze: 100_000_00,
      vorjahresgrenzeUeberschritten: false,
    });
    await expect(run(draft.id, false, kurzVorDerGrenze)).rejects.toThrow(/Kleinunternehmergrenze/);
    expect(await status(draft.id)).toBe("draft");
  });

  it("mit senden: ohne E-Mail-Zugang oder ohne Adresse wird nichts festgeschrieben", async () => {
    const draft = await ebayDraft();
    expect(await run(draft.id, true)).toMatchObject({ ok: false, code: "unprocessable", message: expect.stringMatching(/kein E-Mail-Zugang/) });
    await mailSettings();
    await sql`update contacts set email = '' where id = ${contactId}`;
    expect(await run(draft.id, true)).toMatchObject({ ok: false, code: "unprocessable", message: expect.stringMatching(/keine E-Mail-Adresse/) });
    expect(await status(draft.id)).toBe("draft");
  });

  it("mit senden: genau eine Mail, auch bei einem zweiten Aufruf", async () => {
    await mailSettings();
    const draft = await ebayDraft();
    expect(await run(draft.id, true)).toMatchObject({ ok: true, finalized: true, versand: { status: "gesendet" } });
    expect(await run(draft.id, true)).toMatchObject({ ok: true, finalized: false, versand: { status: "schon_gesendet" } });
    expect(sent.map((m) => m.to)).toEqual(["abc@members.ebay.com"]);
  });

  it("scheitert nur der Versand, bleibt die Rechnung festgeschrieben, und ein neuer Aufruf holt die Mail nach", async () => {
    await mailSettings();
    const draft = await ebayDraft();
    mailFails = true;
    expect(await run(draft.id, true)).toMatchObject({
      ok: true,
      finalized: true,
      versand: { status: "fehlgeschlagen", fehler: expect.stringMatching(/Postfach voll/) },
    });
    expect(await status(draft.id)).toBe("final");
    mailFails = false;
    expect(await run(draft.id, true)).toMatchObject({ ok: true, finalized: false, versand: { status: "gesendet" } });
    expect(sent).toHaveLength(1);
  });

  it.each([
    ["SKR03", "ist"],
    ["SKR04", "soll"],
  ] as const)("bucht im %s bei %s-Versteuerung wie das Festschreiben von Hand", async (kontenrahmen, versteuerung) => {
    await sql`update company set kontenrahmen = ${kontenrahmen}, versteuerung = ${versteuerung} where id = 1`;
    const viaApi = await ebayDraft({}, { externalSource: "ebay", externalId: "A" });
    const vonHand = await ebayDraft({}, { externalSource: "ebay", externalId: "B" });
    await run(viaApi.id);
    await rechnungen.finalizeInvoice(actor, vonHand.id, kleinunternehmerStand);
    const lines = (id: string) => sql`select l.account, l.debit, l.credit from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.source_type = 'invoice' and e.source_id = ${id} order by l.account, l.debit`;
    expect(await lines(viaApi.id)).toEqual(await lines(vonHand.id));
  });
});
