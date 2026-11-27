import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

/**
 * Knopfarten aus styles.css (DESIGN.md, Knöpfe): Ein gesperrter Knopf färbt sich beim Überfahren nicht, gleich welcher Art.
 * Braucht keinen Server: die Regeln kommen direkt aus der Datei, die Schriften fehlen dabei.
 */
const ARTEN = ["btn", "btn btn-primary", "btn btn-danger", "btn btn-destructive", "btn btn-dashed", "btn btn-ghost", "btn btn-ghost btn-icon"];

for (const mode of ["light", "dark"]) {
  test(`gesperrte Knöpfe färben sich beim Überfahren nicht (Modus ${mode})`, async ({ page }) => {
    const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
    const knoepfe = ARTEN.map((art) => `<button type="button" class="${art}" disabled>${art}</button>`).join("");
    await page.setContent(
      `<html data-theme="wald" data-mode="${mode}"><style>${css}</style><body><div class="actions" style="padding: 16px">${knoepfe}</div></body></html>`,
    );
    // Ohne Übergang, sonst misst der Test eine Zwischenfarbe
    await page.addStyleTag({ content: "* { transition: none !important; }" });
    for (const art of ARTEN) {
      const knopf = page.locator(`button[class="${art}"]`);
      const vorher = await knopf.evaluate((el) => getComputedStyle(el).backgroundColor);
      await knopf.hover({ force: true });
      expect(await knopf.evaluate((el) => getComputedStyle(el).backgroundColor), `${art}: Fläche beim Überfahren`).toBe(vorher);
      await page.mouse.move(0, 0);
    }
  });
}

test("Seitenkopf am Handy: Menüknopf mit Text füllt nach Umbruch die Zeile, Symbolknopf bleibt kompakt", async ({ page }) => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  await page.setViewportSize({ width: 320, height: 640 });
  await page.setContent(
    `<html data-theme="wald"><style>${css}</style><body><div class="main"><div class="page-head"><div><h1>Bank</h1></div><div class="actions"><button type="button" class="btn">Datei importieren</button><div class="more-actions-menu"><button type="button" class="btn btn-primary">Konto verbinden</button></div></div></div></div></body></html>`,
  );
  const aktionen = await page.locator(".page-head .actions").boundingBox();
  const hauptaktion = await page.getByRole("button", { name: "Konto verbinden" }).boundingBox();
  expect(aktionen).not.toBeNull();
  expect(hauptaktion).not.toBeNull();
  // Hauptaktion im Menüknopf schließt rechts mit der Aktionszeile ab (DESIGN.md, Reihenfolge der Knöpfe)
  expect(Math.abs(hauptaktion!.x + hauptaktion!.width - (aktionen!.x + aktionen!.width))).toBeLessThanOrEqual(1);

  // Symbolknopf im Menüknopf (⋯) bleibt kompakt und dehnt sich nicht über die ganze Breite
  await page.setContent(
    `<html data-theme="wald"><style>${css}</style><body><div class="main"><div class="page-head"><div><h1>Beleg</h1></div><div class="actions"><button type="button" class="btn btn-primary">Speichern</button><div class="more-actions-menu"><button type="button" class="btn btn-icon" aria-label="Weitere Aktionen">⋯</button></div></div></div></div></body></html>`,
  );
  const symbol = await page.getByRole("button", { name: "Weitere Aktionen" }).boundingBox();
  expect(symbol?.width ?? 999).toBeLessThanOrEqual(48);
});

test("Mahnungseditor am Handy: Vorschau und Entwurf als PDF teilen sich die erste Zeile zu gleichen Teilen", async ({ page }) => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.setContent(
    `<html data-theme="wald"><style>${css}</style><body><div class="main"><div class="page-head"><div><h1>Zahlungserinnerung</h1></div><div class="actions editor-actions"><div class="split-btn-solo"><button type="button" class="btn">Vorschau</button></div><button type="button" class="btn">Entwurf als PDF</button><button type="button" class="btn btn-primary">Zahlungserinnerung erstellen</button></div></div></div></body></html>`,
  );
  const vorschau = await page.getByRole("button", { name: "Vorschau" }).boundingBox();
  const pdf = await page.getByRole("button", { name: "Entwurf als PDF" }).boundingBox();
  expect(vorschau).not.toBeNull();
  expect(pdf).not.toBeNull();
  expect(Math.abs(vorschau!.y - pdf!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(vorschau!.width - pdf!.width)).toBeLessThanOrEqual(2);
});
