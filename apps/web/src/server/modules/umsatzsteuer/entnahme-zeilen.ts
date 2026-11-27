import type { Anteilszeile } from "@haben/core";
import { inArray } from "drizzle-orm";
import { schema, type Db, type Tx } from "../../db/index.ts";

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
    .where(inArray(schema.documentSplits.documentId, eindeutig));
  for (const row of rows) {
    const zeile: Anteilszeile = { category: row.category, taxRate: row.taxRate as number, net: row.net, tax: row.tax };
    result.set(row.documentId, [...(result.get(row.documentId) ?? []), zeile]);
  }
  return result;
}
