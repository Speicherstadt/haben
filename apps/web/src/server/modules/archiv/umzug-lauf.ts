import { and, desc, eq } from "drizzle-orm";

import { LEGACY_SOURCE } from "../../../lib/altbestand.ts";

import { db, schema } from "../../db/index.ts";

import type { LegacySource, LexofficeImportProgress } from "../../db/schema.ts";

/** Ohne Fortschritt und ohne laufenden Auftrag gilt ein Abruf nach drei Minuten als unterbrochen. */

export const STALE_MS = 3 * 60 * 1000;

const controllers = new Map<LegacySource, Map<string, AbortController>>();

const uploads = new Map<LegacySource, Set<string>>();

/** Je Quelle bleibt der Abbruch auf deren eigene Aufträge begrenzt. */

export function importControllersFor(source: LegacySource) {
  let running = controllers.get(source);

  if (!running) {
    running = new Map();
    controllers.set(source, running);
  }

  return running;
}

export function runningUploadsFor(source: LegacySource) {
  let running = uploads.get(source);

  if (!running) {
    running = new Set();
    uploads.set(source, running);
  }

  return running;
}

function interruptedMessage(source: LegacySource) {
  if (source === "sevdesk-export") return "Der Lauf wurde unterbrochen. Lade den Export erneut hoch.";

  if (source === "wiso" || source === "buchhaltungsbutler") return "Der Import wurde unterbrochen. Ein neuer Import setzt dort fort.";

  return "Der Abruf wurde unterbrochen. Ein neuer Abruf setzt dort fort.";
}

/** Letzter Auftrag einer Quelle; verwaiste Aufträge nach einem Serverneustart abschließen. */

export async function latestImportFor(source: LegacySource) {
  const [row] = await db
    .select()
    .from(schema.lexofficeImports)

    .where(eq(schema.lexofficeImports.source, source))
    .orderBy(desc(schema.lexofficeImports.startedAt))
    .limit(1);

  if (!row) return null;

  const running = controllers.get(source)?.has(row.id) || uploads.get(source)?.has(row.id);

  if (row.status === "laeuft" && !running && Date.now() - row.updatedAt.getTime() > STALE_MS) {
    const [updated] = await db
      .update(schema.lexofficeImports)

      .set({ status: "abgebrochen", error: interruptedMessage(source), finishedAt: new Date() })

      .where(and(eq(schema.lexofficeImports.id, row.id), eq(schema.lexofficeImports.status, "laeuft")))
      .returning();

    return updated ?? row;
  }

  return row;
}

/** Der eindeutige Abrufindex gilt für alle Quellen, auch für später ergänzte Umzüge. */

export async function refreshImportRuns() {
  const runs = new Map<LegacySource, Awaited<ReturnType<typeof latestImportFor>>>();

  for (const source of Object.keys(LEGACY_SOURCE) as LegacySource[]) runs.set(source, await latestImportFor(source));

  return runs;
}

export async function finish(id: string, progress: LexofficeImportProgress, status: "fertig" | "fehler" | "abgebrochen", error: string | null) {
  progress.phase = "fertig";
  await db
    .update(schema.lexofficeImports)
    .set({ status, error, progress, updatedAt: new Date(), finishedAt: new Date() })
    .where(eq(schema.lexofficeImports.id, id));
}
