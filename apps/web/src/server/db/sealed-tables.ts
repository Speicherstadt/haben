import type { Abfrage } from "@firsttris/gobd-kern/sperren";

/**
 * Tabellen, die in ein Siegel eingehen (#1580): jede mit einem Trigger auf haben_seal() und die Kindtabellen, die
 * haben_seal_columns für sie nennt. Nur für den Generator auf einer frisch migrierten Datenbank: Die Prüfung einer
 * Instanz nimmt die Tabellen aus dem ausgelieferten Sollbestand, sonst bestimmte eine veränderte Funktion den Umfang.
 * Läuft mit search_path = public (leseMomentaufnahme), weil haben_seal_columns haben_columns ohne Schema aufruft.
 */
export async function sealedTables(abfrage: Abfrage): Promise<string[]> {
  const rows = await abfrage<{ table: string }>(`
    select distinct pg_catalog.format('%I.%I', 'public', part.name) collate pg_catalog."C" as "table"
    from (select distinct c.relname from pg_catalog.pg_trigger t
      join pg_catalog.pg_class c on c.oid = t.tgrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_proc p on p.oid = t.tgfoid join pg_catalog.pg_namespace pn on pn.oid = p.pronamespace
      where n.nspname = 'public' and pn.nspname = 'public' and p.proname = 'haben_seal' and not t.tgisinternal) sealed
    cross join lateral pg_catalog.jsonb_object_keys(public.haben_seal_columns(sealed.relname::text)) part(name)
    order by 1`);
  return rows.map((row) => row.table);
}
