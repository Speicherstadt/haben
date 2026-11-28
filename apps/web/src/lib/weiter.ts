/** Wohin die Anmeldung nie zurückkehrt: Schnittstellen und die Seiten der Anmeldung selbst */
const NIE = ["/api", "/login", "/setup", "/einladung"];

const BASIS = "http://haben.invalid";

/**
 * Ein eigener Pfad der App als Ziel nach der Anmeldung, oder null. Nur relative Pfade derselben Herkunft, kein `//`, kein
 * Backslash und keine Steuerzeichen, die Browser unterschiedlich auslegen: kein offener Redirect. Zurück kommt der
 * normalisierte Pfad mit Suchzeile, ohne Fragment.
 */
export function eigenesZiel(ziel: unknown): string | null {
  if (typeof ziel !== "string" || !ziel.startsWith("/") || ziel.startsWith("//") || /[\\\p{Cc}]/u.test(ziel)) return null;
  const url = new URL(ziel, BASIS);
  if (url.origin !== BASIS || NIE.some((pfad) => url.pathname === pfad || url.pathname.startsWith(`${pfad}/`))) return null;
  return url.pathname + url.search;
}

/** Ziel nach der Anmeldung aus der rohen Suchzeile der Login-Seite (?weiter=…), oder null */
export function weiterNachAnmeldung(search: string): string | null {
  return eigenesZiel(new URLSearchParams(search).get("weiter"));
}
