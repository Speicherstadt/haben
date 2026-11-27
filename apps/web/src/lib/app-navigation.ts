/**
 * Hilfsfunktionen für den Routenwechsel im App-Layout (`routes/_app.tsx`):
 * - Kein `getAuthState`-Wasserfall bei Wechseln innerhalb von `/_app`, bis `router.invalidate()` oder `clearCache()` läuft.
 * - Beim Wechsel auf eine andere Seite (`pathname` ändert sich) zeigt `<main>` sofort die Ladeansicht statt
 *   der alten Seite; reine Suchparameter-Wechsel (Filter, Suche, Jahr) lassen die aktuelle Seite stehen.
 */

export interface AppContextCache<T> {
  read: (cause: "enter" | "stay" | "preload") => T | undefined;
  seed: (value: T) => void;
  clear: () => void;
}

/**
 * Hält den Kontext von `/_app` im Browser zwischen Seitenwechseln fest, damit `beforeLoad` nicht vor jedem
 * Kind-Loader erneut `getAuthState()` blockierend abfragt. Auf dem Server (`browser = false`) und beim frischen
 * Betreten nach `/login` oder `/setup` (`cause === "enter"`) liefert er immer `undefined`.
 */
export function createAppContextCache<T>(browser: () => boolean = () => typeof window !== "undefined"): AppContextCache<T> {
  let cached: T | undefined;
  return {
    read(cause) {
      if (!browser() || cause === "enter") return undefined;
      return cached;
    },
    seed(value) {
      if (browser()) cached = value;
    },
    clear() {
      cached = undefined;
    },
  };
}

export const appContextCache = createAppContextCache<unknown>();

export interface NavigationZustand {
  /** Zuletzt fertig gerenderter Pfad (für Fokuswechsel nach dem Laden) */
  resolvedPathname: string;
  /** Pfad für die Markierung in der Navigation (reagiert sofort auf den Klick) */
  navPathname: string;
  /** True, solange eine andere Seite lädt (nicht bei reinen Suchparameter-Änderungen derselben Seite) */
  wechseltSeite: boolean;
}

export function navigationZustand({
  status,
  locationPathname,
  resolvedPathname,
}: {
  status: "pending" | "idle";
  locationPathname: string;
  resolvedPathname: string | undefined;
}): NavigationZustand {
  const aktuell = resolvedPathname ?? locationPathname;
  return {
    resolvedPathname: aktuell,
    navPathname: locationPathname,
    wechseltSeite: status === "pending" && locationPathname !== aktuell,
  };
}
