import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUNNING_TEXTS } from "@haben/core";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { kleinunternehmerStand } from "../auswertungen/test-umsatz-stand.ts";

/** Text eines PDFs mit pdftotext (poppler-utils), Leerraum zusammengefasst; ohne das Werkzeug null */
function pdfText(pdf: Uint8Array): string | null {
  const dir = mkdtempSync(join(tmpdir(), "haben-standard-"));
  try {
    writeFileSync(join(dir, "beleg.pdf"), pdf);
    return execFileSync("pdftotext", [join(dir, "beleg.pdf"), "-"], { encoding: "utf8" }).replace(/\s+/g, " ");
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Standard-Textbaustein je Belegart (#1494): füllt neue Belege vor, löst die Standard-Einleitung der Firmendaten ab
describe.skipIf(!testDatabaseUrl)("Standard-Textbaustein je Belegart (Postgres, #1494)", () => {
  let sql: postgres.Sql;
  let invoices: typeof import("./index.ts");
  let quotes: typeof import("./quotes.ts");
  let dunning: typeof import("./dunning.ts");
  let docs: typeof import("./order-documents.ts");
  let stammdaten: typeof import("../stammdaten/index.ts");
  let contacts: typeof import("../stammdaten/contacts.ts");
  let withActor: typeof import("../../db/actor.ts").withActor;
  let contactId: string;
  const actor = "test-user";

  beforeAll(async () => {
    sql = await setupTestDb();
    invoices = await import("./index.ts");
    quotes = await import("./quotes.ts");
    dunning = await import("./dunning.ts");
    docs = await import("./order-documents.ts");
    stammdaten = await import("../stammdaten/index.ts");
    contacts = await import("../stammdaten/contacts.ts");
    ({ withActor } = await import("../../db/actor.ts"));
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    await leeren(sql)`truncate dunnings, text_blocks, quote_lines, quotes, quote_number_counters, journal_lines, journal_entries, invoice_lines, invoices,
      invoice_number_counters, contact_versions, contacts, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, ust_id, bundesland, iban, bic, bank)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'rechnung@example.com', '198/113/10010', 'DE123456789', 'BY',
              'DE89370400440532013000', 'COBADEFFXXX', 'Commerzbank')`;
    const contact = await contacts.createContact(actor, {
      kundennummer: "10001",
      name: "Nordwerk Software GmbH",
      strasse: "Hafenstraße 5",
      plz: "20457",
      ort: "Hamburg",
      land: "DE",
      email: "kunde@example.com",
      ustId: "",
      iban: "",
      leitwegId: "",
      defaultFormat: null,
    });
    contactId = contact.id;
  });

  const lines = [{ description: "Beratung", quantity: 1000, unit: "Std." as const, unitPrice: 10_000, taxRate: 1900 as const }];
  type Standard = NonNullable<import("../stammdaten/index.ts").TextBlockInput["standardFuer"]>;
  const baustein = (kind: "kopf" | "fuss", text: string, standardFuer: Standard | null, name = text) =>
    stammdaten.createTextBlock(actor, { name, kind, text, contactId: null, standardFuer });

  it("ohne Standard beginnen Rechnung und Angebot ohne Einleitung und Hinweis", async () => {
    await baustein("kopf", "Nur zum Einfügen", null);
    expect(await invoices.newDraftDefaults("2026-11-04")).toMatchObject({ intro: "", note: "" });
    expect(await quotes.newQuoteDefaults("2026-11-04")).toMatchObject({ intro: "", note: "" });
  });

  it("füllt neue Rechnungen und Angebote mit Kopf- und Fußtext ihres Standards vor, Platzhalter bleiben stehen", async () => {
    await baustein("kopf", "Für die Leistungen {leistungszeitraum} berechne ich Ihnen:", "rechnung");
    await baustein("fuss", "Bitte {betrag} bis {faellig} überweisen.", "rechnung");
    await baustein("kopf", "Gerne biete ich Ihnen an:", "angebot");
    expect(await invoices.newDraftDefaults("2026-11-04")).toMatchObject({
      intro: "Für die Leistungen {leistungszeitraum} berechne ich Ihnen:",
      note: "Bitte {betrag} bis {faellig} überweisen.",
    });
    expect(await quotes.newQuoteDefaults("2026-11-04")).toMatchObject({ intro: "Gerne biete ich Ihnen an:", note: "" });
  });

  it("ein neuer Standard löst den alten derselben Belegart und Art ab; archiviert ist keiner mehr Standard", async () => {
    const alt = await baustein("kopf", "Alte Einleitung", "rechnung");
    const neu = await baustein("kopf", "Neue Einleitung", "rechnung");
    await baustein("fuss", "Fußtext bleibt", "rechnung");
    const standard = async () => Object.fromEntries((await sql`select id, standard_fuer from text_blocks`).map((r) => [r.id, r.standard_fuer]));
    expect((await standard())[alt.id]).toBeNull();
    expect((await standard())[neu.id]).toBe("rechnung");
    expect(await invoices.newDraftDefaults("2026-11-04")).toMatchObject({ intro: "Neue Einleitung", note: "Fußtext bleibt" });

    // Auch beim Bearbeiten: der alte wird wieder Standard, der neue verliert ihn
    await stammdaten.updateTextBlock(actor, alt.id, {
      name: "Alte Einleitung",
      kind: "kopf",
      text: "Alte Einleitung",
      contactId: null,
      standardFuer: "rechnung",
    });
    expect((await standard())[neu.id]).toBeNull();

    await stammdaten.setTextBlockArchived(actor, alt.id, true);
    expect((await standard())[alt.id]).toBeNull();
    expect((await invoices.newDraftDefaults("2026-11-04")).intro).toBe("");
    // Ein archivierter Baustein kann nicht Standard werden und nimmt dem aktiven nichts weg
    const aktiv = await baustein("kopf", "Aktive Einleitung", "rechnung");
    await expect(
      stammdaten.updateTextBlock(actor, alt.id, { name: "Alte Einleitung", kind: "kopf", text: "Alte Einleitung", contactId: null, standardFuer: "rechnung" }),
    ).rejects.toThrow(/zuerst wieder her/);
    expect((await standard())[aktiv.id]).toBe("rechnung");
    await stammdaten.setTextBlockArchived(actor, alt.id, false);
    expect((await standard())[alt.id]).toBeNull();
  });

  it("lehnt einen Standard für einen Kunden und einen Kopftext für den Lieferschein ab", async () => {
    await expect(stammdaten.createTextBlock(actor, { name: "Kunde", kind: "kopf", text: "x", contactId, standardFuer: "rechnung" })).rejects.toThrow(
      /für alle Kunden/,
    );
    await expect(baustein("kopf", "Lieferschein-Kopf", "lieferschein")).rejects.toThrow(/nur ein Fußtext/);
    expect(await sql`select id from text_blocks`).toHaveLength(0);
  });

  it("ein geänderter Standard ändert keinen schon angelegten Entwurf", async () => {
    const b = await baustein("kopf", "Vorgabe Rechnung", "rechnung");
    const entwurf = await invoices.createDraft(actor, { ...(await invoices.newDraftDefaults("2026-11-04")), contactId, lines });
    await stammdaten.updateTextBlock(actor, b.id, { name: "x", kind: "kopf", text: "Neue Vorgabe", contactId: null, standardFuer: "rechnung" });
    expect((await invoices.getInvoice(entwurf.id))?.invoice.intro).toBe("Vorgabe Rechnung");
  });

  it("die Mahnung nimmt Kopf- und Fußtext des Standards ihrer Stufe, ohne Standard die Texte der Stufe (#1678)", async () => {
    const rechnung = await invoices.finalizeInvoice(
      actor,
      (await invoices.createDraft(actor, { ...(await invoices.newDraftDefaults("2026-10-01")), contactId, paymentTermDays: 14, lines })).id,
      kleinunternehmerStand,
    );
    const texte = async () => (await dunning.dunningDraft(rechnung.id, "2026-11-20"))!.texts;
    expect(await texte()).toEqual(DUNNING_TEXTS);
    await baustein("kopf", "Unsere Rechnung ist noch offen.", "mahnstufe_1");
    await baustein("fuss", "Bei Rückfragen rufen Sie mich gern an.", "mahnstufe_3");
    expect(await texte()).toEqual({
      1: { intro: "Unsere Rechnung ist noch offen.", closing: DUNNING_TEXTS[1].closing },
      2: DUNNING_TEXTS[2],
      3: { intro: DUNNING_TEXTS[3].intro, closing: "Bei Rückfragen rufen Sie mich gern an." },
    });
    // Ein neuer Standard löst nur den derselben Stufe und Art ab
    await baustein("kopf", "Zweite Fassung der Erinnerung", "mahnstufe_1");
    await baustein("kopf", "Wir mahnen die Rechnung an.", "mahnstufe_2");
    expect(await sql`select text, standard_fuer from text_blocks where standard_fuer is not null order by standard_fuer, kind`).toEqual([
      { text: "Zweite Fassung der Erinnerung", standard_fuer: "mahnstufe_1" },
      { text: "Wir mahnen die Rechnung an.", standard_fuer: "mahnstufe_2" },
      { text: "Bei Rückfragen rufen Sie mich gern an.", standard_fuer: "mahnstufe_3" },
    ]);
    expect((await texte())[1].intro).toBe("Zweite Fassung der Erinnerung");
  });

  it("ein Standard „Mahnung“ aus einer älteren Exportdatei gilt für jede Stufe, wie nach der Migration (#1678)", async () => {
    const LANG = `${"a".repeat(178)}😀${"b".repeat(20)}`;
    await withActor(actor, (tx) =>
      stammdaten.textbausteineUebernehmen(tx, [
        { name: "Offen", kind: "kopf", text: "Unsere Rechnung ist noch offen.", contactId: null, standardFuer: "mahnung", archivedAt: null },
        { name: "Alt", kind: "fuss", text: "Archiviert", contactId: null, standardFuer: "mahnung", archivedAt: "2026-11-01T00:00:00.000Z" },
        { name: LANG, kind: "fuss", text: "Bei Rückfragen rufen Sie mich gern an.", contactId: null, standardFuer: "mahnung", archivedAt: null },
      ]),
    );
    // Der lange Name wird gekürzt, ohne das Emoji zu teilen, und bleibt bei 200 UTF-16-Einheiten wie im Formular
    expect((await sql`select name from text_blocks where kind = 'fuss' and standard_fuer is not null order by standard_fuer`).map((r) => r.name)).toEqual([
      `${"a".repeat(178)} (Zahlungserinnerung)`,
      LANG,
      `${"a".repeat(178)}😀bbb (Letzte Mahnung)`,
    ]);
    expect(
      await sql`select name, kind, standard_fuer, archived_at is not null as archiviert from text_blocks where kind = 'kopf' or archived_at is not null order by name`,
    ).toEqual([
      { name: "Alt", kind: "fuss", standard_fuer: null, archiviert: true },
      { name: "Offen", kind: "kopf", standard_fuer: "mahnstufe_2", archiviert: false },
      { name: "Offen (Letzte Mahnung)", kind: "kopf", standard_fuer: "mahnstufe_3", archiviert: false },
      { name: "Offen (Zahlungserinnerung)", kind: "kopf", standard_fuer: "mahnstufe_1", archiviert: false },
    ]);
  });

  it("Auftragsbestätigung nimmt ihren Standard nur ohne eigenen Text des Angebots, der Lieferschein beim Erzeugen", async () => {
    const angenommen = async (intro: string) => {
      const draft = await quotes.createQuoteDraft(actor, { ...(await quotes.newQuoteDefaults("2026-11-02")), contactId, intro, lines });
      const angebot = await quotes.finalizeQuote(actor, draft.id);
      await quotes.setQuoteDecision(actor, angebot.id, "angenommen");
      return angebot;
    };
    const mitText = await angenommen("Einleitung des Angebots");
    const ohneText = await angenommen("");
    await baustein("kopf", "Vielen Dank für Ihren Auftrag {nummer}.", "auftragsbestaetigung");
    await baustein("fuss", "Ware vollständig erhalten:", "lieferschein");
    const eigene = pdfText((await docs.confirmationPdf(mitText.id)).pdf);
    const standard = pdfText((await docs.confirmationPdf(ohneText.id)).pdf);
    const lieferschein = pdfText((await docs.deliveryNotePdf("angebot", mitText.id)).pdf);
    if (eigene === null || standard === null || lieferschein === null) return; // ohne pdftotext nur die Erzeugung geprüft
    // Entscheidung des Maintainers in #1576: Der eigene Text des Angebots geht vor
    expect(eigene).toContain("Einleitung des Angebots");
    expect(eigene).not.toContain(`Vielen Dank für Ihren Auftrag ${mitText.number}.`);
    expect(standard).toContain(`Vielen Dank für Ihren Auftrag ${ohneText.number}.`);
    expect(lieferschein).toContain("Ware vollständig erhalten:");
  }, 60_000);

  it("übernimmt die Standard-Einleitungen einer älteren Exportdatei als Bausteine, ohne einen vorhandenen Standard zu überschreiben", async () => {
    await baustein("kopf", "Schon da", "angebot");
    await withActor(actor, (tx) => stammdaten.alteStandardEinleitungen(tx, { invoiceIntro: "Aus der alten Datei", quoteIntro: "Auch alt", name: "x" }));
    expect(await invoices.newDraftDefaults("2026-11-04")).toMatchObject({ intro: "Aus der alten Datei" });
    expect(await quotes.newQuoteDefaults("2026-11-04")).toMatchObject({ intro: "Schon da" });
    // Eine neue Datei ohne die Felder ändert nichts
    await withActor(actor, (tx) => stammdaten.alteStandardEinleitungen(tx, { name: "x" }));
    expect(await sql`select id from text_blocks`).toHaveLength(2);
  });
});
