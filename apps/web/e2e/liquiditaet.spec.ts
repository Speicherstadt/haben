import { expect, test } from "@playwright/test";
import { SESSION } from "./daten.ts";
import { axeVerstoesse } from "./einrichtung.ts";
import { HANDY } from "./kopfzeile.ts";

/*
 * Liquiditätsvorschau (#1381) mit den Daten aus app.spec.ts (offene Rechnungen, Dauerbeleg Miete): über den Link der Auswertungen
 * öffnen, Horizont umschalten, einen Zeitraum aufklappen und von einem Posten zu seiner Quelle springen, Überfälliges mit Status
 * und eigentlichem Termin, überfällige Forderungen ausblenden; Mindestbestand einstellen mit Hinweis, Linie und Aufgabe in der Übersicht.
 */

test.use({ storageState: SESSION });

test("Liquidität: Horizont umschalten, Zeitraum aufklappen, Posten bis zur Quelle", async ({ page }) => {
  await page.goto("/auswertungen");
  await page.locator(".page-head").getByRole("link", { name: "Liquidität" }).click();
  await expect(page).toHaveURL(/\/auswertungen\/liquiditaet$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Liquiditätsvorschau");
  await expect(page.getByRole("table", { name: "Liquiditätsvorschau 13 Wochen" })).toBeVisible();

  await page.getByLabel("Horizont").selectOption("12m");
  await expect(page).toHaveURL(/horizont=12m/);
  const tabelle = page.getByRole("table", { name: "Liquiditätsvorschau 12 Monate" });
  await expect(tabelle.getByRole("columnheader", { name: "Monat" })).toBeVisible();
  await expect(tabelle.getByRole("rowheader", { name: "Gesamt" })).toBeVisible();

  // Der Dauerbeleg Miete aus app.spec.ts kommt jeden Monat: Der erste Zeitraum mit Posten klappt auf
  const umschalter = tabelle.locator("a[aria-expanded]").first();
  await umschalter.click();
  await expect(umschalter).toHaveAttribute("aria-expanded", "true");
  const posten = page.locator(".liq-posten");
  await expect(posten).toBeVisible();
  await expect(posten.getByRole("columnheader", { name: "Sicherheit" })).toBeVisible();
  await posten.locator('a[href*="/rechnungen/"], a[href*="/belege/"], a[href*="/dauerbelege/"]').first().click();
  await expect(page).toHaveURL(/\/(rechnungen|belege|dauerbelege)\/[0-9a-f-]{36}$/);
});

test("Liquidität: Überfälliges steht heute mit Status „Überfällig“ und dem eigentlichen Termin", async ({ page }) => {
  await page.goto("/auswertungen/liquiditaet?horizont=12m");
  // Überfälliges steht heute, also im ersten Zeitraum
  await page.getByRole("table", { name: "Liquiditätsvorschau 12 Monate" }).locator("a[aria-expanded]").first().click();
  const posten = page.locator(".liq-posten tbody tr");
  // Der Beleg aus app.spec.ts war am 25.10.2025 fällig und ist nicht bezahlt
  const beleg = posten.filter({ hasText: "2025-4711" });
  const status = beleg.locator(".status.status-warn.status-urgent");
  await expect(status.locator(".status-label")).toHaveText("Überfällig");
  await expect(status.locator(".status-detail")).toHaveText("fällig 25.10.2025");
  // Jeder überfällige Posten nennt seinen Termin, Steuertermine wie Belege
  for (const zeile of await posten.filter({ hasText: "Überfällig" }).all()) {
    await expect(zeile.locator(".status-detail")).toHaveText(/^fällig \d\d\.\d\d\.\d{4}$/);
  }
});

test("Liquidität: überfällige Forderungen ausblenden und 4 Wochen je Woche", async ({ page }) => {
  await page.goto("/auswertungen/liquiditaet?horizont=4w");
  const tabelle = page.getByRole("table", { name: "Liquiditätsvorschau 4 Wochen" });
  await expect(tabelle.getByRole("columnheader", { name: "Woche" })).toBeVisible();
  await page.getByLabel("Überfällige Forderungen einrechnen").uncheck();
  await expect(page).toHaveURL(/ueberfaellige=false/);
  await expect(page.getByLabel("Überfällige Forderungen einrechnen")).not.toBeChecked();
  await expect(tabelle.locator("tbody tr").first()).toBeVisible();
});

test("Liquidität am Handy: Horizont und Schalter stehen ganz im Bild", async ({ page }) => {
  await page.setViewportSize(HANDY);
  await page.goto("/auswertungen/liquiditaet");
  for (const element of [page.getByLabel("Horizont"), page.locator(".liq-wahl label.checkbox")]) {
    const box = await element.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(HANDY.width);
  }
});

// Der Mindestbestand gehört zu den Daten, die „mit-daten“ teilt: Brach der Test ab, bevor er ihn entfernte, entfernt ihn
// afterAll. In der Gruppe läuft es nur im Worker dieser Tests, nicht in einem, der die übrigen Tests der Datei nahm; die Tests
// der Gruppe laufen nacheinander, weil jeder den Mindestbestand ändert.
test.describe("Mindestbestand", () => {
  test.describe.configure({ mode: "serial" });
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ storageState: SESSION });
    await page.goto("/auswertungen/liquiditaet", { waitUntil: "networkidle" });
    const feld = page.getByRole("textbox", { name: "Mindestbestand" });
    if ((await feld.inputValue()) !== "") {
      await feld.fill("");
      await page.getByRole("button", { name: "Speichern", exact: true }).click();
      await expect(page.getByText("Mindestbestand entfernt.")).toBeVisible();
    }
    await page.close();
  });

  test("einstellen, Hinweis und Linie auf der Seite, Aufgabe in der Übersicht, wieder entfernen", async ({ page }) => {
    await page.goto("/auswertungen/liquiditaet");
    const karte = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Mindestbestand", exact: true }) });
    const feld = karte.getByLabel("Mindestbestand");
    await expect(feld).toHaveValue("");
    await expect(page.locator(".chart .grenze")).toHaveCount(0);

    // Prüfung beim Absenden: kein Betrag
    await feld.fill("viel");
    await karte.getByRole("button", { name: "Speichern" }).click();
    await expect(feld).toHaveAttribute("aria-invalid", "true");

    // Weit über dem Kontostand: schon heute darunter
    await feld.fill("10.000.000,00");
    await karte.getByRole("button", { name: "Speichern" }).click();
    // Die Meldung nennt das Ergebnis, weil der Hinweis oben auf der Seite außer Sicht steht
    await expect(karte.getByRole("status")).toHaveText(/^Mindestbestand gespeichert\. Der Kontostand unterschreitet ihn am \d\d\.\d\d\.\d{4}\.$/);
    await expect(
      page
        .getByRole("note")
        .filter({ hasText: /^Kontostand unterschreitet Mindestbestand am \d\d\.\d\d\.\d{4}\. Erwartet .+ unter dem Mindestbestand von 10\.000\.000,00/ }),
    ).toBeVisible();
    await expect(page.locator(".chart .grenze")).toHaveCount(1);
    // barrierefreiheit.spec.ts sieht die Seite ohne Mindestbestand; Hinweis und Linie nur hier
    expect(await axeVerstoesse(page)).toEqual([]);

    await page.goto("/");
    // Nahe Fristen stehen vorn, die früheste zuerst; überfällige können die Aufgabe unter „Weitere“ schieben
    const weitere = page.locator("details.todo-weitere");
    if ((await weitere.count()) > 0) await weitere.locator("summary").click();
    const aufgabe = page.getByRole("link", { name: /Kontostand unterschreitet Mindestbestand am \d\d\.\d\d\.\d{4}/ });
    await expect(aufgabe).toContainText("unter dem Mindestbestand von 10.000.000,00");
    expect(await axeVerstoesse(page)).toEqual([]);
    await aufgabe.click();
    await expect(page).toHaveURL(/\/auswertungen\/liquiditaet$/);

    // Leer heißt keine Warnung: Hinweis, Linie und Aufgabe verschwinden
    await karte.getByLabel("Mindestbestand").fill("");
    await karte.getByRole("button", { name: "Speichern" }).click();
    await expect(karte.getByText("Mindestbestand entfernt.")).toBeVisible();
    await expect(page.locator(".chart .grenze")).toHaveCount(0);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Übersicht");
    await expect(page.getByText(/Kontostand unterschreitet Mindestbestand/)).toHaveCount(0);
  });

  test("die Meldung nach dem Speichern widerspricht dem Hinweis nicht, wenn danach der Horizont wechselt", async ({ page }) => {
    // Tiefpunkt in 4 Wochen als Mindestbestand: darüber, in 12 Monaten (Miete jeden Monat) darunter
    const tiefpunkt = async (horizont: string) => {
      await page.goto(`/auswertungen/liquiditaet?horizont=${horizont}`);
      const text = await page.locator(".liq-kennzahlen .card").filter({ hasText: "Tiefpunkt" }).locator(".kpi-value").textContent();
      return (text ?? "").trim().replace(/\s*€$/, "");
    };
    const euro = (betrag: string) => Number(betrag.replace(/\./g, "").replace(",", "."));
    const imMonat = await tiefpunkt("4w");
    expect(euro(imMonat)).toBeGreaterThanOrEqual(0);
    expect(euro(await tiefpunkt("12m"))).toBeLessThan(euro(imMonat));

    await page.goto("/auswertungen/liquiditaet?horizont=4w");
    const karte = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Mindestbestand", exact: true }) });
    await karte.getByLabel("Mindestbestand").fill(imMonat);
    await karte.getByRole("button", { name: "Speichern" }).click();
    await expect(karte.getByRole("status")).toHaveText("Mindestbestand gespeichert. Der Kontostand bleibt im gewählten Horizont darüber.");
    const hinweis = page.getByRole("note").filter({ hasText: "Kontostand unterschreitet Mindestbestand" });
    await expect(hinweis).toHaveCount(0);

    await page.getByLabel("Horizont").selectOption("12m");
    await expect(hinweis).toBeVisible();
    await expect(karte.getByText("bleibt im gewählten Horizont darüber")).toHaveCount(0);
  });
});
