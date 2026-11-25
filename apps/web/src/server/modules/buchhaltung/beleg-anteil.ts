import { splitPrivateShare, type Cents } from "@haben/core";
import { inArray } from "drizzle-orm";
import { db, schema, type Db, type Tx } from "../../db/index.ts";

/**
 * Betrieblicher Anteil je Beleg und Steuersatz aus den Zeilen einer Aufteilung mit Privatanteil (#1914): Netto und die
 * anteilige Vorsteuer des Satzes ohne den privaten Teil. Voranmeldung und Zwischenkonto rechnen damit wie die Buchung.
 * Belege ohne Anteil in ihren Zeilen fehlen. Hier und nicht bei den Belegen, weil das Modul Umsatzsteuer unter den Belegen
 * steht (scripts/modulgrenzen/schichten.ts).
 */
export async function splitBusinessByRate(ids: string[], q: Db | Tx = db): Promise<Map<string, Map<number, { base: Cents; tax: Cents }>>> {
  const result = new Map<string, Map<number, { base: Cents; tax: Cents }>>();
  if (ids.length === 0) return result;
  const rows = await q
    .select({
      documentId: schema.documentSplits.documentId,
      taxRate: schema.documentSplits.taxRate,
      net: schema.documentSplits.net,
      tax: schema.documentSplits.tax,
      privateShare: schema.documentSplits.privateShare,
    })
    .from(schema.documentSplits)
    .where(inArray(schema.documentSplits.documentId, ids));
  // Alle Zeilen eines Belegs zählen, sobald eine davon einen Anteil trägt
  const mitAnteil = new Set(rows.flatMap((row) => (row.privateShare > 0 ? [row.documentId] : [])));
  for (const row of rows) {
    if (!mitAnteil.has(row.documentId)) continue;
    const je = result.get(row.documentId) ?? new Map<number, { base: Cents; tax: Cents }>();
    const bisher = je.get(row.taxRate) ?? { base: 0, tax: 0 };
    je.set(row.taxRate, {
      base: bisher.base + splitPrivateShare(row.net, row.privateShare).business,
      tax: bisher.tax + splitPrivateShare(row.tax, row.privateShare).business,
    });
    result.set(row.documentId, je);
  }
  return result;
}

/** Eine Betragszeile mit dem betrieblichen Anteil ihrer Zeilen (#1914); ohne Anteil bleibt sie, wie sie ist */
export function betrieblicheZeile<T extends { documentId: string; rate: number; net: Cents; tax: Cents }>(
  je: ReadonlyMap<string, ReadonlyMap<number, { base: Cents; tax: Cents }>>,
  row: T,
): T {
  const anteil = je.get(row.documentId)?.get(row.rate);
  return anteil ? { ...row, net: anteil.base, tax: anteil.tax } : row;
}
