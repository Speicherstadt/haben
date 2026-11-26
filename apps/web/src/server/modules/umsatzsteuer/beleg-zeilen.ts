import {
  abziehbareSteuer,
  betrieblicheZahlungsanteile,
  gespeicherterAnteil,
  type BelegAnteilZeile,
  type Cents,
  type InvoiceTotals,
  type TaxShare,
  type Prozent,
} from "@haben/core";
import { inArray } from "drizzle-orm";
import { db, schema, type Db, type Tx } from "../../db/index.ts";

/*
 * Zeilen eines aufgeteilten Belegs (#1914) mit ihrem Privatanteil. Buchung, Voranmeldung und Zwischenkonto rechnen damit
 * je Zeile; Belege ohne Aufteilung fehlen, für sie gilt der Privatanteil des Belegs auf seinen Sätzen.
 *
 * Abziehbar ist nur der betriebliche Teil (§ 15 Abs. 1 Satz 1 Nr. 1 UStG); die Aufteilung bei gemischter Nutzung folgt
 * § 15 Abs. 4 UStG, der private Teil ist eine Entnahme (§ 4 Abs. 1 Satz 2 und § 12 Nr. 1 EStG).
 */

/** Betrag eines Belegs je Steuersatz, mit dem beim Buchen festgehaltenen abziehbaren Anteil */
export interface BelegSatz {
  documentId: string;
  rate: number;
  net: number;
  tax: number;
  vorsteuerAnteil: number | null;
}

/** Steuersätze des Belegs, mit Vorzeichen wie gebucht oder als Beträge (`betrag`) */
export function belegSaetze(betraege: readonly BelegSatz[], documentId: string, betrag: (x: number) => number = (x) => x): InvoiceTotals["taxes"] {
  return betraege
    .filter((b) => b.documentId === documentId)
    .map((b) => ({ rate: b.rate, base: betrag(b.net), tax: betrag(b.tax), vorsteuerAnteil: b.vorsteuerAnteil }))
    .sort((x, y) => y.rate - x.rate);
}

/** Abziehbarer Teil einer Steuer dieses Satzes (§ 15 Abs. 4 UStG), wie beim Buchen festgehalten */
export function abziehbar(totals: InvoiceTotals, rate: number, tax: Cents): Cents {
  return abziehbareSteuer(tax, gespeicherterAnteil({}, totals.taxes.find((t) => t.rate === rate)?.vorsteuerAnteil));
}

/**
 * Geschäftlicher, abziehbarer Anteil je Steuersatz, der zwischen zwei erledigten Beträgen abziehbar wird. Kumuliert
 * gerundet, wie im Journal (vorsteuer-anteile.ts): Je Teilbetrag gerundet ergäben die Zeilen zusammen nicht genau die
 * abziehbare Vorsteuer des Belegs.
 */
export function anteilJeSatz(totals: InvoiceTotals, zeilen: readonly BelegAnteilZeile[], vorher: Cents, nachher: Cents): TaxShare[] {
  const bis = betrieblicheZahlungsanteile(zeilen, nachher);
  const von = betrieblicheZahlungsanteile(zeilen, vorher);
  return bis.map((n) => {
    const v = von.find((x) => x.rate === n.rate);
    return {
      rate: n.rate,
      base: n.base - (v?.base ?? 0),
      tax: abziehbar(totals, n.rate, n.tax) - abziehbar(totals, n.rate, v?.tax ?? 0),
    };
  });
}

/** Zeilen der Aufteilung je Beleg in ihrer Reihenfolge; Belege ohne Aufteilung fehlen */
export async function splitZeilen(ids: string[], q: Db | Tx = db): Promise<Map<string, BelegAnteilZeile[]>> {
  const result = new Map<string, BelegAnteilZeile[]>();
  if (ids.length === 0) return result;
  const rows = await q
    .select({
      documentId: schema.documentSplits.documentId,
      rate: schema.documentSplits.taxRate,
      base: schema.documentSplits.net,
      tax: schema.documentSplits.tax,
      privateShare: schema.documentSplits.privateShare,
      privateAmount: schema.documentSplits.privateAmount,
      privateAmountBasis: schema.documentSplits.privateAmountBasis,
    })
    .from(schema.documentSplits)
    .where(inArray(schema.documentSplits.documentId, ids))
    .orderBy(schema.documentSplits.documentId, schema.documentSplits.position);
  for (const row of rows) {
    const zeilen = result.get(row.documentId) ?? [];
    zeilen.push({
      rate: row.rate,
      base: row.base,
      tax: row.tax,
      privateShare: row.privateShare,
      privateAmount: row.privateAmount,
      privateAmountBasis: row.privateAmountBasis,
    });
    result.set(row.documentId, zeilen);
  }
  return result;
}

/** Zeilen eines Belegs: seine Aufteilung, sonst seine Sätze mit dem Privatanteil des Belegs */
export function belegZeilen(
  documentId: string,
  saetze: readonly { rate: number; base: number; tax: number }[],
  privateShare: Prozent,
  splits: ReadonlyMap<string, readonly BelegAnteilZeile[]>,
): BelegAnteilZeile[] {
  return splits.get(documentId)?.map((zeile) => ({ ...zeile })) ?? saetze.map((satz) => ({ ...satz, privateShare }));
}
