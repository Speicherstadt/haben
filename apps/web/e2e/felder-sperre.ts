import { expect, type Locator, type Page } from "@playwright/test";

/*
 * Formulare, die sich nach einer Aktion mit dem gespeicherten Stand neu aufbauen, sperren ihre Felder, bis das Neuladen
 * fertig ist (DESIGN.md, Gesperrte Knöpfe; #1148, #1793). Geprüft für wiederkehrende Rechnung, Anlage und Dauerbeleg.
 */

const serverFunktion = (url: URL) => url.pathname.startsWith("/_serverFn/");

/**
 * Eingabe gleich nach der Aktion: Das Feld ist gesperrt, und was man danach tippt, steht im neu aufgebauten Formular.
 * Alle Server-Funktionen sind verzögert: das Neuladen, damit die Lücke sicher entsteht, und die Aktion selbst, damit sie
 * in eine andere Sekunde fällt als die Änderung davor. Der `key` der Formulare ist `updatedAt` als Text ohne
 * Millisekunden; in derselben Sekunde baute die Seite nichts neu auf. `neuGeladen` erscheint erst mit den neu geladenen
 * Daten, etwa der neue Titel der Seite; erst danach ist sicher, dass der Neuaufbau vorbei ist.
 */
export async function eingabeNachAktion(page: Page, { aktion, feld, text, neuGeladen }: { aktion: Locator; feld: Locator; text: string; neuGeladen: Locator }) {
  await page.route(serverFunktion, async (route) => {
    await new Promise((fertig) => setTimeout(fertig, 1500));
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
