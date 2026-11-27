import type { PspAdapter } from "./adapter.ts";

/* Hinweise des Anbieters zu geänderten Einstellungen beim Speichern einer Verbindung (#1915), aus verbindungen.ts */

/**
 * Hinweise zu geänderten Einstellungen mit dem gespeicherten Zugang. Nur Hinweise: Lehnt der Anbieter ab oder ist er nicht
 * erreichbar, speichert „Bearbeiten“ trotzdem und sagt, dass nicht geprüft wurde; der nächste Abruf meldet den Fehler.
 */
export async function configHinweise(adapter: PspAdapter, zugang: unknown, config: unknown): Promise<string[]> {
  try {
    return (await adapter.pruefen(zugang, config)).hinweise ?? [];
  } catch (error) {
    return [`Ob der gespeicherte Zugang zu den Einstellungen passt, ließ sich nicht prüfen (${error instanceof Error ? error.message : String(error)}).`];
  }
}

/** Gleiche Einstellungen, unabhängig von der Reihenfolge der Schlüssel (jsonb ordnet sie anders als das Schema) */
export function gleicheConfig(alt: unknown, neu: unknown): boolean {
  const a = alt as Record<string, unknown>;
  const b = neu as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((k) => a[k] === b[k]);
}
