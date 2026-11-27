/**
 * Zustand des Routenwechsels im App-Layout (`routes/_app.tsx`): Beim Wechsel auf eine andere Seite (`pathname` ändert sich)
 * zeigt `<main>` sofort die Ladeansicht statt der alten Seite; reine Suchparameter-Wechsel (Filter, Suche, Jahr) lassen die
 * aktuelle Seite stehen.
 */
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
