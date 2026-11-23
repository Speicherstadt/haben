import type { Kontenrahmen, PostingLine } from "@haben/core";
import { and, eq } from "drizzle-orm";
import { schema, type Tx } from "../../db/index.ts";
import { type openBooks, post, reverseLinesIn } from "../buchhaltung/index.ts";

/** Die Rechnung dokumentiert dieselbe Leistung. Nur die bereits gebuchten Zeilen ihres Papierstornos ausgleichen. */
export async function restorePaperCancellation(
  tx: Tx,
  books: Awaited<ReturnType<typeof openBooks>>,
  replacementId: string,
  replacedId: string,
  description: string,
) {
  const { invoices, journalEntries, journalLines } = schema;
  const entries = await tx
    .select({ entry: journalEntries })
    .from(invoices)
    .innerJoin(journalEntries, and(eq(journalEntries.sourceType, "invoice"), eq(journalEntries.sourceId, invoices.id)))
    .where(and(eq(invoices.correctsId, replacedId), eq(invoices.kind, "storno"), eq(invoices.status, "final")));
  for (const { entry } of entries) {
    const lines = await tx.select().from(journalLines).where(eq(journalLines.entryId, entry.id));
    await post(tx, books, {
      date: entry.date,
      description: `Rechnungsaustausch · ${description}`,
      sourceType: "invoice",
      sourceId: replacementId,
      reversesId: entry.id,
      lines: reverseLinesIn(
        entry.kontenrahmen as Kontenrahmen,
        books.kontenrahmen,
        lines.map((line) => ({
          account: line.account,
          debit: line.debit,
          credit: line.credit,
          taxCode: line.taxCode as PostingLine["taxCode"],
          basis: line.basis,
        })),
      ),
    });
  }
}
