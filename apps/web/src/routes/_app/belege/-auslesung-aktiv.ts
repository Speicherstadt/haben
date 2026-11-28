/** Stand der Warteschlange der KI-Auslesung für die Belegliste (#1735) */
export interface QueueOverview {
  waiting: number;
  running: number;
  failed: number;
  paused: boolean;
}

/** Solange etwas läuft oder wartet und nicht angehalten ist, frischt die Liste sich auf */
export const auslesungAktiv = (queue: QueueOverview) => queue.running > 0 || (queue.waiting > 0 && !queue.paused);
