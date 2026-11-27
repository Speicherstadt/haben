import { readFileSync } from "node:fs";
import { girocodeSvg } from "@haben/einvoice";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * GiroCode zum Überweisen an einem offenen Beleg (#1967): dieselben Angaben wie in der SEPA-Datei der Sammelüberweisung
 * (offener Betrag, geltende IBAN, Verwendungszweck, Skonto), nur als QR-Code für die Banking-App.
 */

const ACCOUNT_IBAN = "DE89370400440532013000";
const SUPPLIER_IBAN = "DE02120300000000202051";
const OTHER_IBAN = "DE75512108001245126199";

/** E-Rechnung (CII) mit Skonto nach XRechnung BR-DE-18: 2 % in 7 Tagen, 1 % in 14 Tagen; IBAN (BT-84) DE0212… */
const einvoice = () =>
  new TextEncoder().encode(
    readFileSync(new URL("../../../../../../packages/einvoice/test-fixtures/incoming/cii-prefixes.xml", import.meta.url), "utf8").replace(
      "<a:SpecifiedTradePaymentTerms>",
      "<a:SpecifiedTradePaymentTerms><a:Description>#SKONTO#TAGE=7#PROZENT=2.00#\n#SKONTO#TAGE=14#PROZENT=1.00#\n</a:Description></a:SpecifiedTradePaymentTerms><a:SpecifiedTradePaymentTerms>",
    ),
  );

/** Kontoauszug als camt.053 mit einer Abbuchung */
function camt(amount: string, name: string, iban: string) {
  return new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><GrpHdr><MsgId>T</MsgId><CreDtTm>2026-09-30T06:00:00+02:00</CreDtTm></GrpHdr>
<Stmt><Id>1</Id><CreDtTm>2026-09-30T06:00:00+02:00</CreDtTm><Acct><Id><IBAN>${ACCOUNT_IBAN}</IBAN></Id><Ccy>EUR</Ccy></Acct>
<Ntry><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-09-12</Dt></BookgDt>
<AcctSvcrRef>BANK-1</AcctSvcrRef><NtryDtls><TxDtls><RltdPties><Cdtr><Nm>${name}</Nm></Cdtr><CdtrAcct><Id><IBAN>${iban}</IBAN></Id></CdtrAcct></RltdPties>
<RmtInf><Ustrd>Anzahlung</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`);
}

describe.skipIf(!testDatabaseUrl)("GiroCode am Beleg (Postgres, #1967)", () => {
  let bank: typeof import("./index.ts");
  let contacts: typeof import("../stammdaten/contacts.ts");
  let documents: typeof import("../belege/documents.ts");
  let cancellation: typeof import("../belege/cancellation.ts");
  let sql: postgres.Sql;
  const actor = "test-user";

  beforeAll(async () => {
    sql = await setupTestDb();
    bank = await import("./index.ts");
    contacts = await import("../stammdaten/contacts.ts");
    documents = await import("../belege/documents.ts");
    cancellation = await import("../belege/cancellation.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    await leeren(sql)`truncate document_iban_decisions, sepa_transfer_items, sepa_transfers, write_offs, allocations, bank_transactions, bank_imports,
      bank_accounts, journal_lines, journal_entries, document_amounts, documents, contact_versions, contacts, company cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, email, steuernummer, bundesland, iban, bic, versteuerung, kontenrahmen)
      values (1, 'Testfirma', 'Musterstraße 1', '93047', 'Regensburg', 'a@example.com', '198/113/10010', 'BY',
              ${ACCOUNT_IBAN}, 'COBADEFFXXX', 'ist', 'SKR03')`;
  });

  async function supplier(name: string, iban: string) {
    return contacts.createContact(actor, {
      kundennummer: "",
      name,
      strasse: "",
      plz: "",
      ort: "",
      land: "DE",
      email: "",
      ustId: "",
      iban,
      leitwegId: "",
      defaultFormat: null,
      isCustomer: false,
      isSupplier: true,
    });
  }

  let counter = 0;
  async function bookedDocument(fields: {
    supplierName: string;
    invoiceNumber: string;
    contactId?: string;
    net: number;
    payment?: "bank" | "privat";
    currency?: string;
  }) {
    const { id } = await documents.uploadDocument(actor, { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ++counter]), filename: `beleg-${counter}.jpg` });
    await documents.updateDocument(actor, id, {
      supplierName: fields.supplierName,
      supplierUstId: "",
      supplierContactId: fields.contactId ?? null,
      invoiceNumber: fields.invoiceNumber,
      documentDate: "2026-09-10",
      dueDate: "2026-09-24",
      category: "buero",
      payment: fields.payment ?? "bank",
      note: "",
      currency: fields.currency ?? "EUR",
      exchangeRate: fields.currency ? "1,0812" : null,
      // Fremdwährung: Originalbeträge, Euro rechnet Haben mit dem Kurs aus
      amounts: [
        fields.currency
          ? { taxRate: 1900, net: 0, tax: 0, originalNet: fields.net, originalTax: Math.round(fields.net * 0.19) }
          : { taxRate: 1900, net: fields.net, tax: Math.round(fields.net * 0.19) },
      ],
    });
    await documents.bookDocument(actor, id);
    return id;
  }

  /** Bezahlt per Bank: Abbuchung importieren und dem Beleg zuordnen */
  async function pay(documentId: string, cents: number, name: string, iban: string) {
    await bank.createAccount(actor, { name: "Geschäftskonto", iban: ACCOUNT_IBAN });
    await bank.importStatement(actor, { bytes: camt((cents / 100).toFixed(2), name, iban), filename: "auszug.xml" }, null);
    const [tx] = await sql`select id from bank_transactions`;
    await bank.allocate(actor, { kind: "document", transactionId: tx!.id as string, documentId, amount: -cents });
  }

  it("offener Beleg: Code über den offenen Rest an die IBAN des Kontakts, Empfänger und Zweck im SEPA-Zeichensatz", async () => {
    const mueller = await supplier("Büro Müller & Söhne", OTHER_IBAN);
    const id = await bookedDocument({ supplierName: "Büro Müller & Söhne", invoiceNumber: "BM-1/Ä", contactId: mueller.id, net: 10_000 });
    await pay(id, 5_000, "Buero Mueller", OTHER_IBAN);

    const code = await bank.belegGirocode(id, "2026-09-16");
    // Nur der Inhaber bekommt den Bereich, die Steuerberatung bezahlt nichts
    expect(await bank.belegGirocodeFuer("inhaber", id, "2026-09-16")).toEqual(code);
    expect(await bank.belegGirocodeFuer("steuerberatung", id, "2026-09-16")).toBeNull();
    // 119,00 € brutto, 50,00 € schon bezahlt
    expect(code).toMatchObject({ open: 6_900, name: "Buero Mueller + Soehne", iban: OTHER_IBAN, problem: null });
    expect(code!.varianten).toHaveLength(1);
    expect(code!.varianten[0]).toMatchObject({ amount: 6_900, remittance: "BM-1/Ae", skonto: null });
    // Der Code trägt genau diese Angaben
    expect(code!.varianten[0]!.svg).toBe(girocodeSvg({ name: "Buero Mueller + Soehne", iban: OTHER_IBAN, amount: 6_900, text: "BM-1/Ae" }));
  }, 60_000);

  /** E-Rechnung vom 15.09. über 215,63 € mit Skonto (2 % in 7, 1 % in 14 Tagen), IBAN der E-Rechnung bestätigt */
  async function eRechnungMitSkonto(invoiceNumber = "RE-2026/0815") {
    const { id } = await documents.uploadDocument(actor, { bytes: einvoice(), filename: "RE-2026-0815.xml" });
    await documents.updateDocument(actor, id, {
      supplierName: "Netzwerk Hosting GmbH",
      supplierUstId: "DE987654321",
      invoiceNumber,
      documentDate: "2026-09-15",
      dueDate: "2026-09-29",
      category: "software",
      payment: "bank",
      note: "",
      amounts: [
        { taxRate: 1900, net: 15_432, tax: 2_932 },
        { taxRate: 700, net: 2_990, tax: 209 },
      ],
    });
    await documents.bookDocument(actor, id);
    await bank.decideDocumentIban(actor, id, { wahl: "e-rechnung", kontaktIban: null, rechnungsIban: SUPPLIER_IBAN });
    return id;
  }

  it("Skonto aus der E-Rechnung: zweiter Code mit Abzug und Frist, gerechnet ab heute; nach der letzten Frist nur der offene Betrag", async () => {
    const id = await eRechnungMitSkonto();
    // 2 % von 215,63 € = 4,31 €, bis 22.09.
    const früh = await bank.belegGirocode(id, "2026-09-16");
    expect(früh!.varianten.map(({ amount, remittance, skonto }) => ({ amount, remittance, skonto }))).toEqual([
      { amount: 21_563, remittance: "RE-2026/0815", skonto: null },
      { amount: 21_132, remittance: "RE-2026/0815 abzgl. 2,00 Prozent Skonto 4,31 EUR", skonto: { percent: 200, amount: 431, until: "2026-09-22" } },
    ]);
    expect(früh!.varianten[1]!.svg).toBe(
      girocodeSvg({ name: "Netzwerk Hosting GmbH", iban: SUPPLIER_IBAN, amount: 21_132, text: "RE-2026/0815 abzgl. 2,00 Prozent Skonto 4,31 EUR" }),
    );
    // Am letzten Tag der Frist gilt sie noch
    expect((await bank.belegGirocode(id, "2026-09-22"))!.varianten[1]!.skonto).toEqual({ percent: 200, amount: 431, until: "2026-09-22" });
    // Nach dem 22.09. noch 1 % bis 29.09.
    expect((await bank.belegGirocode(id, "2026-09-25"))!.varianten[1]!.skonto).toEqual({ percent: 100, amount: 216, until: "2026-09-29" });
    expect((await bank.belegGirocode(id, "2026-09-30"))!.varianten.map((v) => v.skonto)).toEqual([null]);
  }, 60_000);

  it("teilweise bezahlt: kein Skonto mehr, nur der Code über den Rest (wie in der Sammelüberweisung)", async () => {
    const id = await eRechnungMitSkonto();
    await pay(id, 10_000, "Netzwerk Hosting GmbH", SUPPLIER_IBAN);
    const code = await bank.belegGirocode(id, "2026-09-16");
    expect(code!.open).toBe(11_563);
    expect(code!.varianten.map(({ amount, skonto }) => ({ amount, skonto }))).toEqual([{ amount: 11_563, skonto: null }]);
  }, 60_000);

  it("Verwendungszweck höchstens 140 Zeichen; der Skonto-Zusatz fällt beim Kürzen zuerst weg, wie in der SEPA-Datei", async () => {
    const id = await eRechnungMitSkonto(`R-${"Ä".repeat(80)}`);
    const code = await bank.belegGirocode(id, "2026-09-16");
    expect(code!.varianten).toHaveLength(2);
    for (const v of code!.varianten) expect(v.remittance).toBe(`R-${"Ae".repeat(69)}`);
  }, 60_000);

  it("kein Code, wenn Haben nicht überweisen kann: der Grund wie in der Sammelüberweisung", async () => {
    const ohne = await bookedDocument({ supplierName: "Ohne Konto KG", invoiceNumber: "OK-1", net: 5_000 });
    expect(await bank.belegGirocode(ohne, "2026-09-16")).toMatchObject({
      open: 5_950,
      iban: null,
      problem: "IBAN fehlt: im Kontakt des Lieferanten eintragen",
      problemImKontakt: true,
      varianten: [],
    });
    const typo = await supplier("Tippfehler GmbH", "DE00370400440532013000");
    const ungültig = await bookedDocument({ supplierName: "Tippfehler GmbH", invoiceNumber: "TF-1", contactId: typo.id, net: 2_000 });
    expect(await bank.belegGirocode(ungültig, "2026-09-16")).toMatchObject({
      problem: "IBAN DE00370400440532013000 ist ungültig (Kontakt)",
      problemImKontakt: true,
      varianten: [],
    });
    // Fremdwährung und IBAN außerhalb des EWR: kein Code, und der Kontakt hilft nicht
    const fremd = await bookedDocument({ supplierName: "US Inc.", invoiceNumber: "US-1", net: 3_000, currency: "USD" });
    expect(await bank.belegGirocode(fremd, "2026-09-16")).toMatchObject({
      problem: "Rechnung in USD: SEPA überweist nur Euro",
      problemImKontakt: false,
      varianten: [],
    });
    const zürich = await supplier("Zürich AG", "CH9300762011623852957");
    const ch = await bookedDocument({ supplierName: "Zürich AG", invoiceNumber: "ZH-1", contactId: zürich.id, net: 4_000 });
    expect(await bank.belegGirocode(ch, "2026-09-16")).toMatchObject({
      iban: "CH9300762011623852957",
      problem: "IBAN CH9300762011623852957 liegt außerhalb des EWR: bitte direkt im Online-Banking überweisen",
      problemImKontakt: false,
      varianten: [],
    });
  }, 60_000);

  it("Link zum Kontakt nur, wenn der Kontakt das Problem behebt, nicht bei offener IBAN-Entscheidung (#410)", async () => {
    const netzwerk = await supplier("Netzwerk Hosting GmbH", OTHER_IBAN);
    const { id } = await documents.uploadDocument(actor, { bytes: einvoice(), filename: "RE-2026-0815.xml" });
    await documents.updateDocument(actor, id, {
      supplierName: "Netzwerk Hosting GmbH",
      supplierUstId: "DE987654321",
      supplierContactId: netzwerk.id,
      invoiceNumber: "RE-2026/0815",
      documentDate: "2026-09-15",
      dueDate: "2026-09-29",
      category: "software",
      payment: "bank",
      note: "",
      amounts: [{ taxRate: 1900, net: 18_120, tax: 3_443 }],
    });
    await documents.bookDocument(actor, id);
    expect(await bank.belegGirocode(id, "2026-09-16")).toMatchObject({
      iban: null,
      problem: "Die E-Rechnung nennt eine andere IBAN als der Kontakt: am Beleg entscheiden, welche gilt",
      problemImKontakt: false,
      varianten: [],
    });
    // Ohne Kontakt-IBAN: Die IBAN der E-Rechnung bestätigt man am Beleg, nicht im Kontakt
    await sql`delete from document_iban_decisions`;
    const { id: unbestätigt } = await documents.uploadDocument(actor, {
      // Andere Bytes als die erste E-Rechnung, sonst erkennt der Upload sie als dieselbe Datei
      bytes: new Uint8Array([...einvoice(), ...new TextEncoder().encode("<!-- zweite -->")]),
      filename: "RE-2026-0816.xml",
    });
    await documents.updateDocument(actor, unbestätigt, {
      supplierName: "Netzwerk Hosting GmbH",
      supplierUstId: "DE987654321",
      invoiceNumber: "RE-2026/0816",
      documentDate: "2026-09-15",
      dueDate: "2026-09-29",
      category: "software",
      payment: "bank",
      note: "",
      amounts: [{ taxRate: 1900, net: 18_120, tax: 3_443 }],
    });
    await documents.bookDocument(actor, unbestätigt);
    expect(await bank.belegGirocode(unbestätigt, "2026-09-16")).toMatchObject({
      iban: null,
      problem: "Die IBAN aus der E-Rechnung ist noch nicht bestätigt: am Beleg übernehmen",
      problemImKontakt: false,
      varianten: [],
    });
  }, 60_000);

  it("kein Bereich für bezahlte, privat bezahlte, ungebuchte und stornierte Belege", async () => {
    const mueller = await supplier("Büro Müller", OTHER_IBAN);
    const bezahlt = await bookedDocument({ supplierName: "Büro Müller", invoiceNumber: "BM-2", contactId: mueller.id, net: 10_000 });
    await pay(bezahlt, 11_900, "Buero Mueller", OTHER_IBAN);
    expect(await bank.belegGirocode(bezahlt, "2026-09-16")).toBeNull();

    const privat = await bookedDocument({ supplierName: "Büro Müller", invoiceNumber: "BM-3", contactId: mueller.id, net: 1_000, payment: "privat" });
    expect(await bank.belegGirocode(privat, "2026-09-16")).toBeNull();

    const { id: offen } = await documents.uploadDocument(actor, { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 99]), filename: "neu.jpg" });
    expect(await bank.belegGirocode(offen, "2026-09-16")).toBeNull();

    // Storniert: auch kein Bereich
    await sql`update company set journal_ab = 2026`;
    const storniert = await bookedDocument({ supplierName: "Büro Müller", invoiceNumber: "BM-4", contactId: mueller.id, net: 2_000 });
    expect(await bank.belegGirocode(storniert, "2026-09-16")).not.toBeNull();
    await cancellation.cancelDocument(actor, storniert, { reason: "falscher Beleg" }, "2026-09-20");
    expect(await bank.belegGirocode(storniert, "2026-09-20")).toBeNull();
  }, 60_000);
});
