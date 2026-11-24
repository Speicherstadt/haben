import { expect, type Page, test } from "@playwright/test";
import { SESSION } from "./daten.ts";
import { gehe, kundeWaehlen, weitereAngabenOeffnen } from "./einrichtung.ts";

/*
 * Weitere Bankverbindungen (#1887, docs/rechnungen-zahlung.md): unter Einstellungen › Firma anlegen, als Vorgabe am Kontakt
 * wählen; der Rechnungseditor schlägt sie für diesen Kunden vor, für einen anderen den Standard. Am Ende archiviert und
 * zurückgesetzt, damit die übrigen Tests von „mit-daten“ den Stand nach „ablauf“ sehen. Was auf dem Beleg und in der
 * E-Rechnung steht, prüft rechnungen/bankverbindung.test.ts.
 */

test.use({ storageState: SESSION });
test.describe.configure({ mode: "serial" });

const BEZEICHNUNG = "Objekt Nord";
const AUSWAHL = `${BEZEICHNUNG} · DE02 1203 0000 0000 2020 51`;

const karte = (page: Page) => page.getByRole("region", { name: "Weitere Bankverbindungen" });

/** Vorgabe am Kontakt Nordwerk: die weitere Bankverbindung oder der Standard */
async function kontaktVorgabe(page: Page, wahl: "weitere" | "standard") {
  await gehe(page, "/kontakte");
  await page
    .getByRole("link", { name: /Nordwerk Software GmbH/ })
    .first()
    .click();
  await expect(page.getByRole("form", { name: "Kontakt" })).toBeVisible();
  await weitereAngabenOeffnen(page);
  await page.getByLabel("Bankverbindung").selectOption(wahl === "weitere" ? { label: AUSWAHL } : "");
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText(/Gespeichert/)).toBeVisible();
}

test("Bankverbindung anlegen, am Kontakt vorgeben und im Rechnungsentwurf wählen", async ({ page }) => {
  await gehe(page, "/rechnungen/neu");
  // Ohne weitere Bankverbindungen bleibt der Editor, wie er war
  await expect(page.getByLabel("Bankverbindung")).toHaveCount(0);

  await gehe(page, "/einstellungen?bereich=firma");
  await karte(page).getByRole("button", { name: "+ Bankverbindung" }).click();
  await karte(page).getByRole("button", { name: "Bankverbindung anlegen" }).click();
  await expect(karte(page).getByLabel("IBAN")).toHaveAccessibleDescription(/Gib die IBAN ein/);
  await karte(page).getByLabel("Bezeichnung").fill(BEZEICHNUNG);
  await karte(page).getByLabel("IBAN").fill("de02 1203 0000 0000 2020 51");
  await karte(page).getByLabel("Bank", { exact: true }).fill("Deutsche Kreditbank");
  await karte(page).getByRole("button", { name: "Bankverbindung anlegen" }).click();
  await expect(page.getByText(`Bankverbindung „${BEZEICHNUNG}“ angelegt.`)).toBeVisible();
  await expect(karte(page).getByRole("cell", { name: "DE02 1203 0000 0000 2020 51" })).toBeVisible();

  await kontaktVorgabe(page, "weitere");

  await gehe(page, "/rechnungen/neu");
  const auswahl = page.getByLabel("Bankverbindung");
  await expect(auswahl).toHaveValue("");
  await kundeWaehlen(page, "Nordwerk Software GmbH · Hamburg");
  await expect(auswahl.locator("option:checked")).toHaveText(AUSWAHL);
  await kundeWaehlen(page, "Rheinpixel GmbH · Köln");
  await expect(auswahl.locator("option:checked")).toHaveText(/^Standard · DE89 3704/);
  // Bei Lastschrift gilt das Gläubigerkonto aus den Firmendaten: keine Auswahl
  await page.getByLabel("Zahlungsart").selectOption("lastschrift");
  await expect(auswahl).toHaveCount(0);
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: SESSION });
  await kontaktVorgabe(page, "standard").catch(() => undefined);
  await gehe(page, "/einstellungen?bereich=firma");
  const archivieren = karte(page)
    .getByRole("row", { name: new RegExp(BEZEICHNUNG) })
    .getByRole("button", { name: "Archivieren" });
  if (await archivieren.count()) {
    await archivieren.click();
    await expect(page.getByText(`„${BEZEICHNUNG}“ archiviert.`)).toBeVisible();
  }
  await page.close();
});
