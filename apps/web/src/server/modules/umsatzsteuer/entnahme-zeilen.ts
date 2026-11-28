import { PRIVATENTNAHME, type Anteilszeile } from "@haben/core";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema, type Db, type Tx } from "../../db/index.ts";

/**
 * Netto und Steuer der Zeilen `privatentnahme` je Beleg (#1975). Eine Quelle für alle Leser der Vorsteuer: die
 * Nebenbücher (vorsteuer-belege.ts), die Zwischenkonten (vorsteuer-anteile.ts), die Gutschrift (gutschrift.ts) und die
 * Vorsteuer nach Leistungsdatum. Ohne Entnahmezeilen fehlt der Beleg in der Liste; dann gilt der Privatanteil in Prozent
 * (`belegPrivat` in packages/core/src/beleg-anteile.ts).
 */
export async function entnahmeZeilen(ids: readonly string[], q: Db | Tx): Promise<Map<string, Anteilszeile[]>> {
  const eindeutig = [...new Set(ids)];
  const result = new Map<string, Anteilszeile[]>();
  if (eindeutig.length === 0) return result;
  const rows = await q
    .select({
      documentId: schema.documentSplits.documentId,
      category: schema.documentSplits.category,
      taxRate: schema.documentSplits.taxRate,
      net: schema.documentSplits.net,
      tax: schema.documentSplits.tax,
    })
    .from(schema.documentSplits)
    .where(and(inArray(schema.documentSplits.documentId, eindeutig), eq(schema.documentSplits.category, PRIVATENTNAHME)));
  for (const row of rows) {
    const zeile: Anteilszeile = { category: PRIVATENTNAHME, taxRate: row.taxRate as number, net: row.net, tax: row.tax };
    result.set(row.documentId, [...(result.get(row.documentId) ?? []), zeile]);
  }
  return result;
}

/** Kennungen der Belege, deren Aufteilung eine Zeile `privatentnahme` trägt (#1975); für Skonto und die EÜR */
export async function documentsMitEntnahme(ids: readonly string[], q: Db | Tx = db): Promise<Set<string>> {
  return new Set((await entnahmeZeilen(ids, q)).keys());
}
