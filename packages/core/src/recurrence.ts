/**
 * Intervall wiederkehrender Rechnungen als Dauer nach ISO 8601 (Spalte recurring_invoices.recurrence, #1691): Wochen oder
 * Monate, Jahre als P1Y. Nur diese Schreibweisen speichert Haben; fremde wie „P0Y0M1W“ von sevDesk bringt
 * parseRecurrence darauf.
 */
export const RECURRENCES = {
  P1W: "wöchentlich",
  P2W: "alle 2 Wochen",
  P4W: "alle 4 Wochen",
  P1M: "monatlich",
  P2M: "alle 2 Monate",
  P3M: "vierteljährlich",
  P6M: "halbjährlich",
  P1Y: "jährlich",
} as const;

export type Recurrence = keyof typeof RECURRENCES;

export const RECURRENCE_KEYS = Object.keys(RECURRENCES) as [Recurrence, ...Recurrence[]];

export function isRecurrence(value: string): value is Recurrence {
  return Object.hasOwn(RECURRENCES, value);
}

/** Wochen oder Monate eines Intervalls; P1Y sind 12 Monate */
export function recurrenceParts(recurrence: Recurrence): { weeks: number; months: null } | { weeks: null; months: number } {
  const count = Number(recurrence.slice(1, -1));
  const unit = recurrence.at(-1);
  if (unit === "W") return { weeks: count, months: null };
  return { weeks: null, months: unit === "Y" ? count * 12 : count };
}

/** „wöchentlich“, „alle 2 Monate“ …; unbekannt: Strich */
export function recurrenceLabel(value: string): string {
  return isRecurrence(value) ? RECURRENCES[value] : "–";
}

/**
 * Dauer nach ISO 8601 aus Fremddaten („P0Y0M1W“, „P1Y0M“, „P14D“) als Intervall von Haben; null, wenn Haben es nicht
 * kennt oder Monate und Wochen gemischt sind. Tage zählen nur in ganzen Wochen.
 */
export function parseRecurrence(value: string | null | undefined): Recurrence | null {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec((value ?? "").trim());
  if (!m || m[0] === "P") return null;
  const months = Number(m[1] ?? 0) * 12 + Number(m[2] ?? 0);
  const days = Number(m[3] ?? 0) * 7 + Number(m[4] ?? 0);
  if (months > 0 && days > 0) return null;
  const candidate = months > 0 ? (months % 12 === 0 ? `P${months / 12}Y` : `P${months}M`) : days > 0 && days % 7 === 0 ? `P${days / 7}W` : "";
  return isRecurrence(candidate) ? candidate : null;
}
