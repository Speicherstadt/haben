import { expect, type Page, test } from "@playwright/test";
import { SESSION } from "./daten.ts";
import { HANDY } from "./kopfzeile.ts";
import { abgearbeitet } from "./warten.ts";

/*
 * Seitenwechsel bei langsamer Antwort: Solange die neue Seite lädt, zeigt der Inhalt die Ladeansicht statt der alten Seite,
 * auf dem Handy auch nach dem Schließen des Menüs. Reine Filter (Suchparameter) lassen die Seite stehen.
 * Die Server-Funktionen hält der Test im Browser an, bis er sie freigibt.
 */
test.use({ storageState: SESSION });

/** Hält jede Anfrage an eine Server-Funktion zurück, bis `freigeben()` läuft */
async function anhalten(page: Page): Promise<() => Promise<void>> {
  let freigeben!: () => void;
  const frei = new Promise<void>((weiter) => (freigeben = weiter));
  await page.route("**/_serverFn/**", async (route) => {
    await frei;
    await route.continue();
  });
  return async () => {
    freigeben();
    await page.unroute("**/_serverFn/**");
  };
}

test("Handy: nach dem Klick im Menü steht die Ladeansicht statt der alten Seite", async ({ page }) => {
  await page.setViewportSize(HANDY);
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Übersicht", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Menü" }).click();
  const weiter = await anhalten(page);
  const link = page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Rechnungen", exact: true });
  await link.click();

  await expect(page.locator("#inhalt").getByRole("status")).toContainText("Seite wird geladen");
  await expect(page.getByRole("heading", { name: "Übersicht", level: 1 })).toBeHidden();
  // Die Navigation markiert das Ziel schon, während die Seite lädt
  await expect(link).toHaveAttribute("aria-current", "page");

  await weiter();
  await expect(page.getByRole("heading", { name: "Rechnungen", level: 1 })).toBeVisible();
  await expect(page.getByText("Seite wird geladen")).toHaveCount(0);
});

test("Filter auf derselben Seite lassen die Seite stehen", async ({ page }) => {
  await page.goto("/belege", { waitUntil: "networkidle" });
  const weiter = await anhalten(page);
  await page
    .getByRole("navigation", { name: "Filter" })
    .getByRole("link", { name: /^Zu prüfen/ })
    .click();
  await expect(page).toHaveURL(/status=pruefen/);
  await abgearbeitet(page);

  await expect(page.getByRole("heading", { name: "Belege", level: 1 })).toBeVisible();
  await expect(page.getByText("Seite wird geladen")).toHaveCount(0);
  await weiter();
});
