import type postgres from "postgres";

/** Ein Eintrag im Änderungsprotokoll mit früherem Zeitpunkt (ISO 8601) */
export type FruehererEintrag = { at: string; tableName: string; rowId: string; action: string; newValue: Record<string, unknown> };

/**
 * Nur für Tests mit einem Stand aus der Vergangenheit, etwa „im Vormonat noch Kleinunternehmer“: haben_audit_chain setzt
 * `at` beim Einfügen selbst auf now(). Der Test schreibt deshalb an den Triggern vorbei (replica, braucht Superuser) und
 * bildet Hash und Kopf wie die Kette, damit „Kette prüfen“ danach nichts meldet.
 */
export async function protokollEintragen(sql: postgres.Sql, eintraege: FruehererEintrag[], actor = "test"): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    for (const eintrag of eintraege) {
      const [neu] = await tx<{ seq: string }[]>`
        insert into audit_log (at, actor, table_name, row_id, action, new_value, seq, prev_hash, row_hash)
        select ${eintrag.at}::timestamptz, ${actor}, ${eintrag.tableName}, ${eintrag.rowId}, ${eintrag.action}, ${JSON.stringify(eintrag.newValue)}::jsonb,
          coalesce(max(seq), 0) + 1, coalesce((select row_hash from audit_log order by seq desc limit 1), haben_audit_genesis()), ''::bytea
        from audit_log
        returning seq`;
      await tx`update audit_log a set row_hash = haben_audit_hash(a.prev_hash, a) where seq = ${neu!.seq}`;
    }
    await tx`update audit_chain set (seq, hash) = (select seq, row_hash from audit_log order by seq desc limit 1) where id = 1`;
  });
}
