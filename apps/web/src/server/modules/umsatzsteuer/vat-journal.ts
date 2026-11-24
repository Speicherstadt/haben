import {
  bemessungAnZahlungen,
  IST_NACH_LEISTUNG,
  JOURNAL_KENNZAHLEN,
  kennzahlenAusJournal,
  leereJournalKennzahlen,
  periodRange,
  type Cents,
  type JournalKennzahlen,
  type JournalZeile,
  type Kontenrahmen,
  type VatPeriod,
  type Versteuerung,
} from "@haben/core";
import { and, asc, eq, gte, lt, notInArray, or, sql } from "drizzle-orm";
import { invoiceTaxReader } from "../rechnungen/index.ts";
import { schema, type Db, type Tx } from "../../db/index.ts";
import { belegAusAlterVersion } from "./alte-version.ts";
import { belegeWieHeute } from "./beleg-alte-version.ts";
import { zahlungenWieHeute } from "./zahlung-alte-version.ts";

/** Kz 43 und 48 eines Teils der Buchungen */
type SteuerfreiTeil = Record<(typeof IST_NACH_LEISTUNG)[number], Cents>;

interface Buchung {
  id: string;
  sourceType: string;
  sourceId: string;
  /** Bei einer Gegenbuchung (Storno, Aufhebung): die gegengebuchte Buchung */
  reversesId: string | null;
  kontenrahmen: Kontenrahmen;
  versteuerung: Versteuerung;
  alt: boolean;
  /** Buchung einer Kette über § 4 UStG oder Ausfuhr, die nach dem Leistungstag zählt (exempt_rule, #1312): Rechnung, Zahlung, Ausbuchung */
  nachLeistung: boolean;
  /** Darunter die Buchung einer Anzahlung samt Steuerplan, Storno, Korrektur und Ausbuchung */
  steuerfreieAnzahlung: boolean;
  zeilen: JournalZeile[];
}

/*
 * Kennzahlen der Voranmeldung aus dem Journal (#542, #1116, docs/adr/journal-als-quelle.md): die Quelle der Voranmeldung,
 * wie bei DATEV aus Konto und Steuerschlüssel der Buchungen im Zeitraum (kennzahlenAusJournal). Ohne
 * Eröffnungen (vorgetragen, im Vorjahr angemeldet) und ohne die Buchungen des Anlagenverzeichnisses: Die Privatnutzung von
 * Fahrzeugen rechnet die Voranmeldung je Monat aus dem Anlagenverzeichnis, das Journal bucht sie erst mit der AfA.
 * Dazu zwei Teile von Kz 43 und 48, die die Voranmeldung im Zeitraum der Leistung anders zählt (#1312,
 * steuerfrei-nach-leistung.ts), nur aus Ketten mit dem Kennzeichen exempt_rule: `zahlungsanteil` trägt die
 * Bemessungsgrundlage an Zahlungen (bemessungAnZahlungen), `anzahlungsanteil` die Buchungen steuerfreier Anzahlungen samt
 * ihrem Steuerplan. Vorher festgeschriebene Ketten zählen wie gebucht.
 */
export async function kennzahlenAusDemJournal(
  period: VatPeriod,
  versteuerung: Versteuerung,
  q: Db | Tx,
): Promise<{ kennzahlen: JournalKennzahlen; zahlungsanteil: SteuerfreiTeil; anzahlungsanteil: SteuerfreiTeil }> {
  const { start, end } = periodRange(period);
  const e = schema.journalEntries;
  const l = schema.journalLines;
  const rows = await q
    .select({
      id: e.id,
      sourceType: e.sourceType,
      sourceId: e.sourceId,
      reversesId: e.reversesId,
      kontenrahmen: e.kontenrahmen,
      alt: belegAusAlterVersion,
      account: l.account,
      debit: l.debit,
      credit: l.credit,
      taxCode: l.taxCode,
      basis: l.basis,
      invoiceDate: schema.invoices.issueDate,
      correctsId: schema.invoices.correctsId,
      advanceType: schema.invoices.advanceType,
      invoiceId: schema.invoices.id,
      variant: schema.invoices.variant,
      serviceFrom: schema.invoices.serviceFrom,
      serviceTo: schema.invoices.serviceTo,
      treatment: schema.invoices.taxTreatment,
      // Zahlung oder Bareinnahme auf eine Rechnung
      zahlungFuer: sql<string | null>`coalesce(${schema.allocations.invoiceId}, ${schema.cashEntries.invoiceId})`,
    })
    .from(l)
    .innerJoin(e, eq(e.id, l.entryId))
    .leftJoin(schema.writeOffs, and(eq(e.sourceType, "ausbuchung"), eq(e.sourceId, schema.writeOffs.id)))
    .leftJoin(schema.allocations, and(eq(e.sourceType, "allocation"), eq(e.sourceId, schema.allocations.id)))
    .leftJoin(schema.cashEntries, and(eq(e.sourceType, "kasse"), eq(e.sourceId, schema.cashEntries.id)))
    .leftJoin(schema.invoices, or(eq(schema.invoices.id, schema.writeOffs.invoiceId), and(eq(e.sourceType, "invoice"), eq(e.sourceId, schema.invoices.id))))
    .where(and(gte(e.date, start), lt(e.date, end), notInArray(e.sourceType, ["eroeffnung", "asset"])))
    .orderBy(asc(e.id));
  const buchungen = new Map<string, Buchung>();
  const taxes = invoiceTaxReader(q);
  const kette = kettenLeser(taxes, q);
  for (const r of rows) {
    let b = buchungen.get(r.id);
    if (!b) {
      // Auch Storno und Korrektur folgen der ursprünglichen Rechnung.
      const rechnung = r.invoiceDate
        ? {
            issueDate: r.invoiceDate,
            correctsId: r.correctsId,
            advanceType: r.advanceType,
            id: r.invoiceId ?? undefined,
            variant: r.variant,
            serviceFrom: r.serviceFrom,
            serviceTo: r.serviceTo,
            taxTreatment: r.treatment ?? "regulaer",
          }
        : null;
      const mode = rechnung ? await taxes.postingMode(rechnung) : versteuerung;
      const anfang = rechnung ? await taxes.original(rechnung) : r.zahlungFuer ? await kette(r.zahlungFuer) : null;
      const steuerfrei = anfang?.taxTreatment === "steuerfrei" || anfang?.taxTreatment === "ausfuhr";
      b = {
        id: r.id,
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        reversesId: r.reversesId,
        kontenrahmen: r.kontenrahmen as Kontenrahmen,
        versteuerung: mode,
        alt: r.alt === true,
        nachLeistung: steuerfrei && anfang.exemptRule === "leistung",
        steuerfreieAnzahlung: rechnung !== null && steuerfrei && anfang.advanceType === "anzahlung",
        zeilen: [],
      };
      buchungen.set(r.id, b);
    }
    b.zeilen.push({ account: r.account, debit: r.debit, credit: r.credit, taxCode: r.taxCode as JournalZeile["taxCode"], basis: r.basis });
  }
  // Belege mit § 13b oder Erwerb von vor #551 (#1396) und Zahlungen bei Ist von vor #552 (#1502) mit der
  // Bemessungsgrundlage wie heute
  return summeDerBuchungen(await belegeWieHeute(await zahlungenWieHeute([...buchungen.values()], q), q));
}

/** Kennzahlen und die Teile von Kz 43 und 48 über die Buchungen eines Zeitraums, je Kontenrahmen und Verfahren der Buchung */
function summeDerBuchungen(buchungen: readonly Buchung[]) {
  const imZeitraum = new Set(buchungen.map((b) => b.id));
  const kennzahlen = leereJournalKennzahlen();
  const zahlungsanteil = { kz43: 0, kz48: 0 };
  const anzahlungsanteil = { kz43: 0, kz48: 0 };
  // Ein Jahr hat einen Kontenrahmen; je Kontenrahmen gerechnet, falls ein Zeitraum doch beide sieht
  for (const kr of ["SKR03", "SKR04"] as const)
    for (const mode of ["ist", "soll"] as const) {
      const eigene = buchungen.filter((b) => b.kontenrahmen === kr && b.versteuerung === mode);
      if (eigene.length === 0) continue;
      const zeilen = eigene.map((b) => b.zeilen);
      const k = kennzahlenAusJournal(kr, mode, zeilen);
      // Kz 50 nennt nur Minderungen nach § 17 Abs. 2 Nr. 1 Satz 1 UStG (Anleitung zur UStVA 2026, Kz 50). Die Gegenbuchung
      // einer Buchung aus einem früheren Zeitraum, etwa der Wiedereingang nach einem Forderungsausfall (Satz 2), erhöht
      // Kz 81/86, mindert Kz 50 aber nicht; im selben Zeitraum heben sich beide auf.
      const frueher = eigene.filter((b) => b.reversesId !== null && !imZeitraum.has(b.reversesId)).map((b) => b.zeilen);
      if (frueher.length > 0) k.kz50 -= kennzahlenAusJournal(kr, mode, frueher).kz50;
      for (const feld of JOURNAL_KENNZAHLEN) kennzahlen[feld] += k[feld];
      const nachLeistung = eigene.filter((b) => b.nachLeistung);
      const z = bemessungAnZahlungen(
        kr,
        nachLeistung.map((b) => b.zeilen),
      );
      const a = kennzahlenAusJournal(
        kr,
        mode,
        nachLeistung.filter((b) => b.steuerfreieAnzahlung).map((b) => b.zeilen),
      );
      for (const feld of IST_NACH_LEISTUNG) {
        zahlungsanteil[feld] += z[feld];
        anzahlungsanteil[feld] += a[feld];
      }
    }
  return { kennzahlen, zahlungsanteil, anzahlungsanteil };
}

/** Anfang der Kette einer Rechnung, an der eine Zahlung hängt, je Leser einmal geladen */
function kettenLeser(taxes: ReturnType<typeof invoiceTaxReader>, q: Db | Tx) {
  const geladen = new Map<string, ReturnType<typeof taxes.original>>();
  return (id: string) => {
    let anfang = geladen.get(id);
    if (!anfang) {
      anfang = q
        .select({ id: schema.invoices.id, issueDate: schema.invoices.issueDate, correctsId: schema.invoices.correctsId })
        .from(schema.invoices)
        .where(eq(schema.invoices.id, id))
        .then(([rechnung]) => taxes.original(rechnung!));
      geladen.set(id, anfang);
    }
    return anfang;
  };
}
