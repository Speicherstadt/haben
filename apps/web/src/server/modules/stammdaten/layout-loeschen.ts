import { DEFAULT_LAYOUT } from "@haben/core";
import { eq, sql } from "drizzle-orm";
import { withActor } from "../../db/actor.ts";
import { schema, type Db, type Tx } from "../../db/index.ts";
import { clearPackages, dropRenderer } from "./layout-pakete.ts";
import { checkLayoutSwitch, loadDesign, lockFooter } from "./letterhead.ts";

/* Löschen eines eigenen Layouts (#113, #1651): Zuordnung zurück auf das eingebaute, ohne die Fußzeile über 4 Spalten zu bringen */

/** Wo das Layout zugeordnet ist, gilt nach dem Löschen das eingebaute; das darf die Fußzeile nicht über 4 Spalten bringen */
async function checkRemoval(q: Db | Tx, id: string): Promise<void> {
  const current = await loadDesign(q);
  const layouts = Object.fromEntries(
    Object.entries(current.layouts).map(([type, ref]) => [type, ref.kind === "eigen" && ref.id === id ? DEFAULT_LAYOUT : ref]),
  ) as typeof current.layouts;
  await checkLayoutSwitch(q, current, { ...current, layouts });
}

/** Löscht ein eigenes Layout in einer Transaktion und räumt danach Renderer und Paket-Cache ab; nacheinander je Layout ruft es deleteLayout */
export async function removeLayout(actor: string, id: string): Promise<void> {
  await withActor(actor, async (tx) => {
    // Erst das Profil, dann das Layout: Jede Änderung nimmt im Audit-Trigger die Sperre der Hash-Kette. Käme das Löschen
    // zuerst, hielte es diese Sperre, während es auf die Zeile des Profils wartet, und verhakte sich mit saveDesign, das
    // die Zeile hält und auf die Sperre wartet.
    await lockFooter(tx);
    await checkRemoval(tx, id);
    const fallback = JSON.stringify(DEFAULT_LAYOUT);
    await tx.execute(sql`
      update letterhead_profiles set settings = jsonb_set(settings, '{layouts}', (
        select coalesce(jsonb_object_agg(key, case when value->>'kind' = 'eigen' and value->>'id' = ${id} then ${fallback}::jsonb else value end), '{}'::jsonb)
        from jsonb_each(coalesce(settings->'layouts', '{}'::jsonb))
      )), updated_at = now()
      where settings->'layouts' is not null`);
    await tx.delete(schema.belegLayouts).where(eq(schema.belegLayouts.id, id));
  });
  // Erst nach der Transaktion: Lehnt die Prüfung der Fußzeile das Löschen ab, bleiben Renderer und Pakete stehen. Scheitert
  // das Aufräumen, ist das Layout trotzdem gelöscht; ein übrig gebliebener Cache gehört zu keinem Layout mehr
  const warnen = (was: string) => (error: unknown) => console.warn(`Layout ${id} gelöscht, ${was}: ${error instanceof Error ? error.message : String(error)}`);
  await dropRenderer(id).catch(warnen("Render-Prozess nicht beendet"));
  await clearPackages(id).catch(warnen("Paket-Cache nicht entfernt"));
}
