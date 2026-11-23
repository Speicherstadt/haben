import {
  JOURNAL_KENNZAHLEN,
  kennzahlenAusJournal,
  leereJournalKennzahlen,
  periodRange,
  type JournalKennzahlen,
  type JournalZeile,
  type Kontenrahmen,
  type VatPeriod,
  type Versteuerung,
} from "@haben/core";
import { and, asc, eq, gte, lt, notInArray, or } from "drizzle-orm";
import { invoiceTaxReader } from "../rechnungen/index.ts";
import { schema, type Db, type Tx } from "../../db/index.ts";
import { belegAusAlterVersion } from "./alte-version.ts";
import { belegeWieHeute } from "./beleg-alte-version.ts";
import { zahlungenWieHeute } from "./zahlung-alte-version.ts";

/*
 * Kennzahlen der Voranmeldung aus dem Journal (#542, #1116, docs/adr/journal-als-quelle.md): die Quelle der Voranmeldung,
 * wie bei DATEV aus Konto und Steuerschlüssel der Buchungen im Zeitraum (kennzahlenAusJournal). Ohne
 * Eröffnungen (vorgetragen, im Vorjahr angemeldet) und ohne die Buchungen des Anlagenverzeichnisses: Die Privatnutzung von
 * Fahrzeugen rechnet die Voranmeldung je Monat aus dem Anlagenverzeichnis, das Journal bucht sie erst mit der AfA.
 */
export async function kennzahlenAusDemJournal(period: VatPeriod, versteuerung: Versteuerung, q: Db | Tx): Promise<JournalKennzahlen> {
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
    })
    .from(l)
    .innerJoin(e, eq(e.id, l.entryId))
    .leftJoin(schema.writeOffs, and(eq(e.sourceType, "ausbuchung"), eq(e.sourceId, schema.writeOffs.id)))
    .leftJoin(schema.invoices, or(eq(schema.invoices.id, schema.writeOffs.invoiceId), and(eq(e.sourceType, "invoice"), eq(e.sourceId, schema.invoices.id))))
    .where(and(gte(e.date, start), lt(e.date, end), notInArray(e.sourceType, ["eroeffnung", "asset"])))
    .orderBy(asc(e.id));
  const buchungen = new Map<string, Buchung>();
  const taxes = invoiceTaxReader(q);
  for (const r of rows) {
    let b = buchungen.get(r.id);
    if (!b) {
      // Auch Storno und Korrektur folgen der ursprünglichen Rechnung.
      const mode = r.invoiceDate
        ? await taxes.postingMode({
            issueDate: r.invoiceDate,
            correctsId: r.correctsId,
            advanceType: r.advanceType,
            id: r.invoiceId ?? undefined,
            variant: r.variant,
            serviceFrom: r.serviceFrom,
            serviceTo: r.serviceTo,
            taxTreatment: r.treatment ?? "regulaer",
          })
        : versteuerung;
      b = {
        id: r.id,
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        reversesId: r.reversesId,
        kontenrahmen: r.kontenrahmen as Kontenrahmen,
        versteuerung: mode,
        alt: r.alt === true,
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

interface Buchung {
  id: string;
  sourceType: string;
  sourceId: string;
  /** Bei einer Gegenbuchung (Storno, Aufhebung): die gegengebuchte Buchung */
  reversesId: string | null;
  kontenrahmen: Kontenrahmen;
  versteuerung: Versteuerung;
  alt: boolean;
  zeilen: JournalZeile[];
}

/** Summe über die Buchungen eines Zeitraums, je Kontenrahmen und Verfahren der Buchung */
function summeDerBuchungen(buchungen: readonly Buchung[]): JournalKennzahlen {
  const imZeitraum = new Set(buchungen.map((b) => b.id));
  const summe = leereJournalKennzahlen();
  // Ein Jahr hat einen Kontenrahmen; je Kontenrahmen gerechnet, falls ein Zeitraum doch beide sieht
  for (const kr of ["SKR03", "SKR04"] as const)
    for (const mode of ["ist", "soll"] as const) {
      const eigene = buchungen.filter((b) => b.kontenrahmen === kr && b.versteuerung === mode);
      if (eigene.length === 0) continue;
      const k = kennzahlenAusJournal(
        kr,
        mode,
        eigene.map((b) => b.zeilen),
      );
      // Kz 50 nennt nur Minderungen nach § 17 Abs. 2 Nr. 1 Satz 1 UStG (Anleitung zur UStVA 2026, Kz 50). Die Gegenbuchung
      // einer Buchung aus einem früheren Zeitraum, etwa der Wiedereingang nach einem Forderungsausfall (Satz 2), erhöht
      // Kz 81/86, mindert Kz 50 aber nicht; im selben Zeitraum heben sich beide auf.
      const frueher = eigene.filter((b) => b.reversesId !== null && !imZeitraum.has(b.reversesId)).map((b) => b.zeilen);
      if (frueher.length > 0) k.kz50 -= kennzahlenAusJournal(kr, mode, frueher).kz50;
      for (const feld of JOURNAL_KENNZAHLEN) summe[feld] += k[feld];
    }
  return summe;
}
