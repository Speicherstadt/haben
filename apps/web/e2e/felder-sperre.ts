import { expect, type Locator, type Page } from "@playwright/test";

/*
 * Formulare, die sich nach einer Aktion mit dem gespeicherten Stand neu aufbauen, sperren ihre Felder, bis das Neuladen
 * fertig ist (DESIGN.md, Gesperrte Knöpfe; #1148, #1793). Geprüft für wiederkehrende Rechnung, Anlage und Dauerbeleg.
 * Der `key` dieser Formulare und des Rechnungseditors ist `updatedAt` in Millisekunden; so bauen sie sich auch nach zwei
 * Speichervorgängen in derselben Sekunde neu auf (#1804).
 */

const serverFunktion = (url: URL) => url.pathname.startsWith("/_serverFn/");

/**
 * Eingabe gleich nach der Aktion: Das Feld ist gesperrt, und was man danach tippt, steht im neu aufgebauten Formular.
 * Alle Server-Funktionen sind verzögert, damit die Sperre zu sehen ist und das Neuladen sicher erst nach der Eingabe
 * fertig wird. `neuGeladen` erscheint erst mit den neu geladenen Daten, etwa der neue Titel der Seite; erst danach ist
 * sicher, dass der Neuaufbau vorbei ist.
 */
export async function eingabeNachAktion(page: Page, { aktion, feld, text, neuGeladen }: { aktion: Locator; feld: Locator; text: string; neuGeladen: Locator }) {
  await page.route(serverFunktion, async (route) => {
    await new Promise((fertig) => setTimeout(fertig, 500));
    await route.fallback();
  });
  await aktion.click();
  await expect(feld).toBeDisabled();
  // fill wartet, bis das Feld wieder frei ist
  await feld.fill(text);
  await expect(neuGeladen).toBeVisible();
  await expect(feld).toHaveValue(text);
  await page.unroute(serverFunktion);
}

/**
 * Mehrmals kurz nacheinander speichern, ohne Verzögerung: Jedes Mal baut sich das Formular mit dem gespeicherten Stand
 * neu auf, auch wenn zwei Speichervorgänge in dieselbe Sekunde fallen (#1804). Zu sehen am Feld: Gespeichert wird der
 * Text ohne Leerzeichen am Ende (beim Absenden oder im Schema des Servers), das Feld selbst behält sie; nur ein neu
 * aufgebautes Formular zeigt den Text ohne sie. Drei Durchgänge, damit praktisch immer zwei Speichervorgänge in dieselbe
 * Sekunde fallen; das nächste `fill` wartet, bis das Feld wieder frei ist.
 */
export async function kurzNacheinanderSpeichern({ feld, speichern, texte }: { feld: Locator; speichern: Locator; texte: string[] }) {
  for (const text of texte) {
    await feld.fill(`${text}  `);
    await speichern.click();
    await expect(feld).toHaveValue(text);
  }
}

/**
 * Speichern per Enter im Feld schlägt fehl: Solange die Anfrage läuft, ist das Feld gesperrt und verliert den Fokus;
 * danach steht er wieder darin (useFokusNachSperre). Die Anfrage scheitert erst nach einer Pause, damit die Sperre zu
 * sehen ist; gespeichert wird nichts.
 */
export async function fokusNachFehlschlag(page: Page, feld: Locator) {
  await page.route(serverFunktion, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise((fertig) => setTimeout(fertig, 1000));
    await route.abort();
  });
  await feld.focus();
  await feld.press("Enter");
  await expect(feld).toBeDisabled();
  await expect(page.getByRole("alert").filter({ hasText: /fetch|Netzwerk|network/i })).toBeVisible();
  await expect(feld).toBeEnabled();
  await expect(feld).toBeFocused();
  await page.unroute(serverFunktion);
}
