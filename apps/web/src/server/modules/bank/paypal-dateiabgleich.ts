import { transactionHash, type ParsedTransaction } from "@haben/import";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Tx } from "../../db/index.ts";

/** Referenzen liefern Verdachtspaare; der Nutzer entscheidet auch bei gleichem Betrag und Tag. */
export async function paypalDateiabgleich(
  tx: Tx,
  accountId: string,
  rows: ParsedTransaction[],
  richtung: "datei" | "abruf",
): Promise<Map<ParsedTransaction, string[]>> {
  const referenceOf = (reference: string) => reference.replace(/\/T[0-9]{4}(?=-gebuehr$|$)/, "");
  const references = [...new Set(rows.flatMap((row) => (row.bankReference ? [referenceOf(row.bankReference)] : [])))];
  if (references.length === 0) return new Map();
  const t = schema.bankTransactions;
  const i = schema.bankImports;
  const candidates = await tx
    .select({ id: t.id, reference: t.bankReference, date: t.bookingDate, amount: t.amount, currency: t.currency })
    .from(t)
    .innerJoin(i, eq(i.id, t.importId))
    .where(
      and(
        eq(t.bankAccountId, accountId),
        inArray(sql<string>`regexp_replace(${t.bankReference}, '/T[0-9]{4}(?=-gebuehr$|$)', '')`, references),
        richtung === "abruf"
          ? and(eq(i.format, "paypal-csv"), sql`not exists (select 1 from import_movements m where m.transaction_id = ${t.id})`)
          : sql`(${i.format} = 'paypal-api' or exists (select 1 from import_movements m join import_sources s on s.id = m.source_id
          where m.transaction_id = ${t.id} and s.provider = 'paypal'))`,
      ),
    );
  const result = new Map<ParsedTransaction, string[]>();
  for (const row of rows) {
    if (!row.bankReference) continue;
    const matches = candidates.filter((candidate) => candidate.reference !== null && referenceOf(candidate.reference) === referenceOf(row.bankReference!));
    if (matches.length > 0)
      result.set(
        row,
        matches.map((candidate) => candidate.id),
      );
  }
  return result;
}

/** Der Nutzer entscheidet über die vorgeschlagenen Paare; beide Umsätze bleiben erhalten. */
export async function paypalVerdachtSpeichern(tx: Tx, transactionId: string, originals: string[]) {
  for (const originalTransactionId of originals) {
    if (transactionId === originalTransactionId) continue;
    await tx.insert(schema.bankDuplicateReviews).values({ transactionId, originalTransactionId }).onConflictDoNothing();
  }
}

/** Unbekannte Ereignisarten haben keine Quellenidentität; Wiederholungen desselben Auszugs bleiben erkennbar. */
export async function paypalAbrufBereitsVorhanden(tx: Tx, accountId: string, row: ParsedTransaction) {
  const t = schema.bankTransactions;
  const i = schema.bankImports;
  const previous = await tx
    .select({ id: t.id })
    .from(t)
    .innerJoin(i, eq(i.id, t.importId))
    .where(
      and(
        eq(t.bankAccountId, accountId),
        eq(i.format, "paypal-api"),
        eq(t.bankReference, row.bankReference!),
        eq(t.bookingDate, row.bookingDate),
        eq(t.amount, row.amount),
        eq(t.currency, row.currency),
        eq(t.purpose, row.purpose),
      ),
    );
  return previous[0]?.id;
}

type HashedRow = ParsedTransaction & { dedupHash: string };

/** Frühere Dateiimporte derselben Zeilen berücksichtigen, neue Verdachtspaare als eigene Umsätze erhalten. */
export async function paypalDateizeilen(
  tx: Tx,
  accountId: string,
  transactions: HashedRow[],
  known: Set<string>,
  paypal: Map<ParsedTransaction, string[]>,
): Promise<{ fresh: HashedRow[]; observedIds: string[] }> {
  const observedIds: string[] = [];
  const fresh: HashedRow[] = [];
  const used = new Set(known);
  const seenPayPal = new Map<string, number>();
  for (const row of transactions) {
    if (!paypal.has(row)) {
      if (!known.has(row.dedupHash)) fresh.push(row);
      used.add(row.dedupHash);
      continue;
    }
    const previous = await tx
      .select({ id: schema.bankTransactions.id })
      .from(schema.bankTransactions)
      .innerJoin(schema.bankImports, eq(schema.bankImports.id, schema.bankTransactions.importId))
      .where(
        and(
          eq(schema.bankTransactions.bankAccountId, accountId),
          eq(schema.bankImports.format, "paypal-csv"),
          eq(schema.bankTransactions.bankReference, row.bankReference!),
          eq(schema.bankTransactions.bookingDate, row.bookingDate),
          eq(schema.bankTransactions.amount, row.amount),
          eq(schema.bankTransactions.currency, row.currency),
          eq(schema.bankTransactions.purpose, row.purpose),
        ),
      );
    const signature = JSON.stringify([row.bankReference, row.bookingDate, row.amount, row.currency, row.purpose]);
    const occurrenceInFile = (seenPayPal.get(signature) ?? 0) + 1;
    seenPayPal.set(signature, occurrenceInFile);
    if (previous.length >= occurrenceInFile) {
      observedIds.push(previous[occurrenceInFile - 1]!.id);
      continue;
    }
    let occurrence = 0;
    let hash = transactionHash(row, occurrence);
    while (
      used.has(hash) ||
      (
        await tx
          .select({ id: schema.bankTransactions.id })
          .from(schema.bankTransactions)
          .where(and(eq(schema.bankTransactions.bankAccountId, accountId), eq(schema.bankTransactions.dedupHash, hash)))
      ).length > 0
    )
      hash = transactionHash(row, ++occurrence);
    used.add(hash);
    fresh.push({ ...row, dedupHash: hash });
  }
  return { fresh, observedIds };
}
