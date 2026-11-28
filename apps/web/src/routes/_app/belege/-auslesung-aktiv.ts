/** Stand der Warteschlange der KI-Auslesung für die Belegliste (#1735) */
export interface QueueOverview {
  waiting: number;
  running: number;
  failed: number;
  paused: boolean;
}

/**
 * Solange etwas läuft oder wartet und nicht angehalten ist, frischt die Liste sich auf. Der Loader liest Belege und
 * Warteschlange in zwei Abfragen; endet eine Auslesung dazwischen, zeigt nur noch die Zeile sie an. Deshalb zählen
 * auch die Zeilen, sonst bliebe „Wird ausgelesen“ bis zum Neuladen stehen (#2085). Gebuchte nicht: Die Warteschlange
 * lässt sie aus, ihr Stand der Auslesung ändert sich nicht mehr.
 */
export function auslesungAktiv(queue: QueueOverview, rows: readonly { status: string; extractionStatus: string }[]): boolean {
  const offen = rows.filter((r) => r.status === "neu");
  const laeuft = queue.running > 0 || offen.some((r) => r.extractionStatus === "laeuft");
  const wartet = queue.waiting > 0 || offen.some((r) => r.extractionStatus === "wartet");
  return laeuft || (wartet && !queue.paused);
}
