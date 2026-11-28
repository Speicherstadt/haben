import type postgres from "postgres";

/** Hilfen für Tests des Abgleichs nur anhängbarer Tabellen mit dem Audit-Log (0339, 0350) */

export type Problem = { art: string; tabelle: string; zeile: string | null; seq: string | null; befund: string };

export const problems = (tx: postgres.Sql | postgres.TransactionSql) => tx<Problem[]>`select art, tabelle, zeile, seq, befund from haben_integrity_problems()`;

/** Führt work in einer Transaktion aus, die danach zurückgerollt wird; liefert ihr Ergebnis */
export async function rolledBack<T>(sql: postgres.Sql, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let result: T;
  const rollback = new Error("rollback");
  await sql
    .begin(async (tx) => {
      result = await work(tx);
      throw rollback;
    })
    .catch((error) => {
      if (error !== rollback) throw error;
    });
  return result!;
}

/** Wie ein Betreiber mit vollem Zugriff: Trigger abgeschaltet */
export async function tamper(tx: postgres.TransactionSql, work: () => Promise<unknown>): Promise<void> {
  await tx`set local session_replication_role = replica`;
  await work();
  await tx`set local session_replication_role = origin`;
}
