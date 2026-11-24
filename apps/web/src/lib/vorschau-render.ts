/** Wie oft die echte Vorschau neu gesetzt wird: mindestens 0,5 s Pause, bei langsamen Rechnern das Doppelte der letzten Renderzeit */
export const RENDER_MIN_DELAY_MS = 500;
/** Länger als das rendert nur noch auf Knopfdruck, sonst käme das Tippen nicht hinterher */
export const RENDER_MANUAL_ABOVE_MS = 2000;

export const renderDelay = (lastMs: number): number => Math.max(RENDER_MIN_DELAY_MS, lastMs * 2);

export const rendersOnDemand = (lastMs: number): boolean => lastMs > RENDER_MANUAL_ABOVE_MS;

/**
 * Nach einem Lauf: Passt das Blatt zum Formular, ist es fertig. Sonst bleibt bei langsamen Läufen der Knopf, bei
 * schnellen wird gleich neu gesetzt; die Entprellung der Eingabe hatte noch mit der alten Renderzeit gerechnet.
 */
export function afterRender(renderedKey: string, currentKey: string, ms: number): "fertig" | "knopf" | "neu" {
  if (renderedKey === currentKey) return "fertig";
  return rendersOnDemand(ms) ? "knopf" : "neu";
}

const PREVIEW_FAILED = "Die Vorschau ließ sich nicht erzeugen.";
/** Texte, mit denen fetch einen Netzfehler meldet: Chromium, Firefox, Safari */
const NETWORK_ERROR = /^(Failed to fetch|NetworkError when attempting to fetch resource\.|Load failed)$/;
/**
 * Fehlerseite des Reverse Proxys, solange Haben neu startet: TanStack Start wirft den Text einer Antwort ohne eigenes
 * Format (serverFnFetcher), also das HTML von nginx, „Invariant failed“ beim leeren 502 von Caddy oder den Text von
 * Traefik: den Statustext, ohne gesunden Container (Provider Docker, Kubernetes) das 404 von Go, mit allowEmptyServices
 * „no available server“, beide mit Zeilenumbruch. Meldungen von Haben sind nie HTML.
 */
const PROXY_PAGE = /^\s*<|^Invariant failed|^(Bad Gateway|Service Unavailable|Gateway Timeout|404 page not found|no available server)\s*$/;

/**
 * Meldung, wenn das Blatt nicht gesetzt werden kann (#1147): immer zuerst der eigene Satz, damit sie sich von einer
 * Meldung zum Speichern unterscheidet. Eine Meldung des Servers (Fachfehler oder „Interner Fehler“) steht dahinter,
 * statt eines Netzfehlers des Browsers oder einer Fehlerseite des Proxys ein deutscher Satz.
 */
export function previewFailure(error: unknown): string {
  if (!(error instanceof Error) || !error.message) return PREVIEW_FAILED;
  if ((error instanceof TypeError && NETWORK_ERROR.test(error.message)) || PROXY_PAGE.test(error.message)) {
    return `${PREVIEW_FAILED} Haben ist gerade nicht erreichbar.`;
  }
  // renderPreview beginnt seine Meldung schon mit dem Satz
  return error.message.startsWith(PREVIEW_FAILED) ? error.message : `${PREVIEW_FAILED} ${error.message}`;
}
