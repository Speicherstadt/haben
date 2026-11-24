import { describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../../test-db.ts";
import { KZ, steuerfreiTestumgebung, type Behandlung } from "./test-steuerfrei.ts";

/*
 * Steuerfreie Umsätze ohne Vorsteuerabzug (Kz 48) und mit Vorsteuerabzug (Kz 43) bei Ist-Versteuerung im Zeitraum der
 * Leistung (#1312). Anleitung zur UStVA 2026 (https://www.elster.de/eportal/helpGlobal?themaGlobal=help_ustva_2026), in
 * beiden Abschnitten gleich: „Anzahlungen zu steuerfreien Umsätzen tragen Sie bitte nicht ein. Den Gesamtbetrag
 * (Anzahlungen und Restzahlung) geben Sie bitte im Voranmeldungszeitraum der Leistungsausführung an.“ Eine Ausnahme für
 * die Ist-Versteuerung nennt sie nicht; Anzahlungen zählen deshalb auch bei Soll nicht. Storno und Korrektur nach Zahlung
 * mindern bei Ist wie bei Soll erst mit der Rückzahlung (#1228, UStAE 17.1 Abs. 2 Satz 3).
 */

const SEP = { year: 2026, month: 9 };
const OKT = { year: 2026, month: 10 };
const NOV = { year: 2026, month: 11 };

describe.skipIf(!testDatabaseUrl)("Kz 43 und 48 bei Ist im Zeitraum der Leistung (Postgres)", () => {
  const actor = "kz48-ist-test";
  const { m, firma, rechnung, zahlung, kennzahl, journalSauber } = steuerfreiTestumgebung(actor);

  /** Anzahlung 200 € im September bezahlt, Leistung im Oktober über 1.000 €, Schlussrechnung im November, Rest 800 € im November bezahlt */
  async function anzahlungUndSchluss(behandlung: Behandlung) {
    const anzahlung = await rechnung(behandlung, 20_000, { issueDate: "2026-09-05", serviceFrom: null, variant: "abschlag", advanceType: "anzahlung" });
    await zahlung(anzahlung.id, "10.09.26", "200,00");
    const schluss = await rechnung(behandlung, 100_000, {
      issueDate: "2026-11-02",
      serviceFrom: "2026-10-01",
      serviceTo: "2026-10-31",
      variant: "schluss",
      deducts: [anzahlung.id],
      contactId: anzahlung.contactId,
    });
    expect(schluss.net).toBe(80_000);
    await zahlung(schluss.id, "16.11.26", "800,00");
  }

  for (const kontenrahmen of ["SKR03", "SKR04"] as const)
    for (const behandlung of ["steuerfrei", "ausfuhr"] as const)
      it(`${kontenrahmen}/ist: ${KZ[behandlung]} mit Anzahlung im September, Leistung im Oktober, Rest im November`, async () => {
        await firma(kontenrahmen, "ist");
        await anzahlungUndSchluss(behandlung);
        expect(await kennzahl(behandlung, SEP)).toBe(0);
        expect(await kennzahl(behandlung, OKT)).toBe(100_000);
        expect(await kennzahl(behandlung, NOV)).toBe(0);
        await journalSauber([SEP, OKT, NOV]);
      }, 60_000);

  for (const [kontenrahmen, behandlung] of [
    ["SKR03", "steuerfrei"],
    ["SKR04", "ausfuhr"],
  ] as const)
    it(`${kontenrahmen}/soll: ${KZ[behandlung]} mit Anzahlung ebenso im Monat der Leistung, die Anzahlung nicht`, async () => {
      await firma(kontenrahmen, "soll");
      await anzahlungUndSchluss(behandlung);
      expect([await kennzahl(behandlung, SEP), await kennzahl(behandlung, OKT), await kennzahl(behandlung, NOV)]).toEqual([0, 100_000, 0]);
      await journalSauber([SEP, OKT, NOV]);
    }, 60_000);

  for (const [kontenrahmen, versteuerung, behandlung] of [
    ["SKR03", "ist", "steuerfrei"],
    ["SKR04", "ist", "ausfuhr"],
    ["SKR04", "soll", "steuerfrei"],
    ["SKR03", "soll", "ausfuhr"],
  ] as const)
    it(`${kontenrahmen}/${versteuerung}: ${KZ[behandlung]} im Monat der Leistung, nicht der Rechnung oder Zahlung`, async () => {
      await firma(kontenrahmen, versteuerung);
      const inv = await rechnung(behandlung, 50_000, { issueDate: "2026-10-03", serviceFrom: "2026-09-01", serviceTo: "2026-09-30" });
      await zahlung(inv.id, "05.11.26", "500,00");
      expect([await kennzahl(behandlung, SEP), await kennzahl(behandlung, OKT), await kennzahl(behandlung, NOV)]).toEqual([50_000, 0, 0]);
    }, 60_000);

  for (const [kontenrahmen, behandlung] of [
    ["SKR04", "steuerfrei"],
    ["SKR03", "ausfuhr"],
  ] as const)
    it(`${kontenrahmen}/ist: Storno im Monat des Stornos, mit umgekehrtem Vorzeichen`, async () => {
      await firma(kontenrahmen, "ist");
      const inv = await rechnung(behandlung, 50_000, { issueDate: "2026-09-10", serviceFrom: "2026-09-10" });
      await m.invoices.cancelInvoice(actor, inv.id, "2026-11-02");
      expect([await kennzahl(behandlung, SEP), await kennzahl(behandlung, OKT), await kennzahl(behandlung, NOV)]).toEqual([50_000, 0, -50_000]);
    }, 60_000);

  for (const [kontenrahmen, versteuerung, behandlung] of [
    ["SKR03", "ist", "steuerfrei"],
    ["SKR04", "ist", "ausfuhr"],
    ["SKR04", "soll", "steuerfrei"],
    ["SKR03", "soll", "ausfuhr"],
  ] as const)
    it(`${kontenrahmen}/${versteuerung}: Storno einer bezahlten Rechnung mindert ${KZ[behandlung]} erst mit der Rückzahlung`, async () => {
      // #1228 bei Ist wie bei Soll: UStAE 17.1 Abs. 2 Satz 3; die Anleitung zur UStVA 2026 („in dem Voranmeldungszeitraum …, in
      // dem die Änderung der Bemessungsgrundlage eingetreten ist“) sagt nichts anderes
      await firma(kontenrahmen, versteuerung);
      const inv = await rechnung(behandlung, 50_000, { issueDate: "2026-09-10", serviceFrom: "2026-09-10" });
      await zahlung(inv.id, "05.10.26", "500,00");
      const storno = await m.invoices.cancelInvoice(actor, inv.id, "2026-11-02");
      await zahlung(storno.id, "10.12.26", "-500,00");
      const DEZ = { year: 2026, month: 12 };
      expect([await kennzahl(behandlung, SEP), await kennzahl(behandlung, OKT), await kennzahl(behandlung, NOV), await kennzahl(behandlung, DEZ)]).toEqual([
        50_000, 0, 0, -50_000,
      ]);
      await journalSauber([SEP, OKT, NOV, DEZ]);
    }, 60_000);

  for (const kontenrahmen of ["SKR03", "SKR04"] as const)
    it(`${kontenrahmen}/ist: Skonto mindert Kz 48 im Monat der Ausbuchung, die Aufhebung gegenläufig`, async () => {
      // Anleitung zur UStVA 2026, Allgemein: „Bitte berücksichtigen Sie Entgelterhöhungen und Entgeltminderungen bei den Bemessungsgrundlagen.“
      await firma(kontenrahmen, "ist");
      const inv = await rechnung("steuerfrei", 80_000, { issueDate: "2026-10-03", serviceFrom: "2026-09-01", serviceTo: "2026-09-30" });
      await zahlung(inv.id, "05.10.26", "784,00");
      await m.bank.writeOff(actor, { kind: "skonto", invoiceId: inv.id, date: "2026-10-05" });
      const [skonto] = await m.bank.listWriteOffs({ invoiceId: inv.id });
      await m.bank.reverseWriteOff(actor, skonto!.id, "2026-11-04");
      expect([await kennzahl("steuerfrei", SEP), await kennzahl("steuerfrei", OKT), await kennzahl("steuerfrei", NOV)]).toEqual([80_000, -1_600, 1_600]);
    }, 60_000);

  it("SKR04/ist: Bareinnahme ohne Rechnung zählt am Tag der Zahlung, eine Bareinnahme auf eine Rechnung nicht", async () => {
    await firma("SKR04", "ist");
    await m.bank.createCashIncome(actor, { date: "2026-10-12", amount: 20_000, text: "Kurs", steuer: { behandlung: "steuerfrei", steuersatz: 0 } }, "2026-11-23");
    const inv = await rechnung("steuerfrei", 30_000, { issueDate: "2026-09-20", serviceFrom: "2026-09-20" });
    await m.bank.createCashInvoiceEntry(actor, { invoiceId: inv.id, date: "2026-10-14", amount: 30_000 }, "2026-11-23");
    expect([await kennzahl("steuerfrei", SEP), await kennzahl("steuerfrei", OKT)]).toEqual([30_000, 20_000]);
  }, 60_000);

  for (const [kontenrahmen, behandlung] of [
    ["SKR03", "steuerfrei"],
    ["SKR04", "ausfuhr"],
  ] as const)
    it(`${kontenrahmen}/ist: Leistung in einem schon gesendeten Monat zeigt an der Rechnung den Hinweis zur Berichtigung`, async () => {
      // Keine spätere Voranmeldung enthält die Rechnung, die Zahlung meldet sie nicht mehr (wie bei Soll, #694)
      await firma(kontenrahmen, "ist");
      const entwurf = await m.vat.saveDraft(actor, OKT, { mode: "berechnet" });
      await m.sql`update vat_returns set status = 'sent', sent_at = now() - interval '1 day' where id = ${entwurf.id}`;
      const inv = await rechnung(behandlung, 50_000, { issueDate: "2026-11-03", serviceFrom: "2026-10-01", serviceTo: "2026-10-31" });
      expect(await m.invoices.leistungsmonatHinweisFuer(inv)).toContain("gehört in die Voranmeldung 10/2026");
      const anzahlung = await rechnung(behandlung, 20_000, {
        issueDate: "2026-11-05",
        serviceFrom: "2026-10-01",
        variant: "abschlag",
        advanceType: "anzahlung",
      });
      expect(await m.invoices.leistungsmonatHinweisFuer(anzahlung)).toBeNull();
    }, 60_000);
  /** Ein Jahr nach Ist, danach Soll: erst eine Buchung im alten Jahr, dann der Wechsel (versteuerungForYear) */
  async function wechselVonIstZuSoll(kontenrahmen: "SKR03" | "SKR04", behandlung: Behandlung) {
    await firma(kontenrahmen, "ist");
    const alt = await rechnung(behandlung, 10_000, { issueDate: "2025-11-03", serviceFrom: "2025-11-03" });
    await zahlung(alt.id, "20.11.25", "100,00");
    await m.sql`update company set versteuerung = 'soll'`;
  }
  const DEZ25 = { year: 2025, month: 12 };
  const JAN26 = { year: 2026, month: 1 };
  const FEB26 = { year: 2026, month: 2 };

  for (const [kontenrahmen, behandlung] of [
    ["SKR03", "steuerfrei"],
    ["SKR04", "ausfuhr"],
  ] as const)
    it(`${kontenrahmen}: nach dem Wechsel von Ist zu Soll zählen Zahlung und Skonto einer Leistung des Ist-Jahres ${KZ[behandlung]} nicht noch einmal`, async () => {
      // TDD-Review: Die Leistung im Dezember (Ist) steht im Dezember; die Zahlung im Soll-Jahr meldete sie ein zweites Mal
      await wechselVonIstZuSoll(kontenrahmen, behandlung);
      const inv = await rechnung(behandlung, 50_000, { issueDate: "2026-01-15", serviceFrom: "2025-12-01", serviceTo: "2025-12-20" });
      await zahlung(inv.id, "10.02.26", "490,00");
      await m.bank.writeOff(actor, { kind: "skonto", invoiceId: inv.id, date: "2026-02-10" });
      const company = await import("../stammdaten/company.ts");
      expect([await company.versteuerungForYear(2025), await company.versteuerungForYear(2026)]).toEqual(["ist", "soll"]);
      expect([await kennzahl(behandlung, DEZ25), await kennzahl(behandlung, JAN26), await kennzahl(behandlung, FEB26)]).toEqual([50_000, 0, -1_000]);
      await journalSauber([DEZ25, JAN26, FEB26]);
    }, 60_000);

  it("SKR04: Storno nach dem Wechsel von Ist zu Soll mindert Kz 48 einer bezahlten Leistung des Ist-Jahres erst mit der Rückzahlung", async () => {
    await firma("SKR04", "ist");
    const inv = await rechnung("steuerfrei", 50_000, { issueDate: "2025-12-05", serviceFrom: "2025-12-05" });
    await zahlung(inv.id, "15.12.25", "500,00");
    await m.sql`update company set versteuerung = 'soll'`;
    const storno = await m.invoices.cancelInvoice(actor, inv.id, "2026-01-20");
    await zahlung(storno.id, "10.02.26", "-500,00");
    expect([await kennzahl("steuerfrei", DEZ25), await kennzahl("steuerfrei", JAN26), await kennzahl("steuerfrei", FEB26)]).toEqual([50_000, 0, -50_000]);
    await journalSauber([DEZ25, JAN26, FEB26]);
  }, 60_000);

  for (const [kontenrahmen, versteuerung, behandlung] of [
    ["SKR03", "soll", "steuerfrei"],
    ["SKR04", "ist", "ausfuhr"],
  ] as const)
    it(`${kontenrahmen}/${versteuerung}: Hinweis an der Schlussrechnung nennt das Entgelt samt abgezogener Anzahlung, wie ${KZ[behandlung]}`, async () => {
      // TDD-Review: Kz 43 und 48 enthalten die ganze Leistung; der Hinweis nannte nur den Rest der Schlussrechnung
      await firma(kontenrahmen, versteuerung);
      const entwurf = await m.vat.saveDraft(actor, OKT, { mode: "berechnet" });
      await m.sql`update vat_returns set status = 'sent', sent_at = now() - interval '1 day' where id = ${entwurf.id}`;
      const anzahlung = await rechnung(behandlung, 20_000, { issueDate: "2026-09-05", serviceFrom: null, variant: "abschlag", advanceType: "anzahlung" });
      await zahlung(anzahlung.id, "10.09.26", "200,00");
      const schluss = await rechnung(behandlung, 100_000, {
        issueDate: "2026-11-02",
        serviceFrom: "2026-10-01",
        serviceTo: "2026-10-31",
        variant: "schluss",
        deducts: [anzahlung.id],
        contactId: anzahlung.contactId,
      });
      expect(await kennzahl(behandlung, OKT)).toBe(100_000);
      expect(await m.invoices.leistungsmonatHinweisFuer(schluss)).toMatch(/\(netto 1\.000,00\s€, Umsatzsteuer 0,00\s€\)/);
    }, 60_000);
});
