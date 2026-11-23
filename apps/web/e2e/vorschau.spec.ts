import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { type Browser, chromium, expect, type Page, type Route, test } from "@playwright/test";
import { SESSION } from "./daten.ts";
import { HANDY, kopfUnterkante, LAPTOP, sichtbar, ziehen, zumEnde } from "./kopfzeile.ts";
import { abgearbeitet, bilder } from "./warten.ts";

/**
 * Vorschau der Belegeditoren (#357): Split-Button „Vorschau“ im Seitenkopf, Überblendung als <dialog>, Anheften neben
 * das Formular, Wahl je Gerät. Mit der Sitzung aus app.spec.ts (Projekt „mit-daten“); gespeichert wird nur im Browser.
 */

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const GROSS = { width: 1920, height: 1080 };

/** Die Sitzung ohne gespeicherte Wahl: app.spec.ts heftet für seine Prüfungen an (vorschauAnheften in daten.ts) */
async function editor(browser: Browser, viewport: { width: number; height: number }, path = "/rechnungen/neu", modus?: "dunkel"): Promise<Page> {
  const state = JSON.parse(readFileSync(SESSION, "utf8")) as {
    cookies: [];
    origins: { origin: string; localStorage: { name: string; value: string }[] }[];
  };
  const origins = state.origins.map((o) => ({ ...o, localStorage: o.localStorage.filter((item) => item.name !== "haben-vorschau") }));
  const context = await browser.newContext({ viewport, storageState: { ...state, origins } });
  if (modus) await context.addInitScript((m) => localStorage.setItem("haben-modus", m), modus);
  const page = await context.newPage();
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return page;
}

/** Eine gültige Position; ohne Preis zeigt die Vorschau „[Positionen]“ */
async function position(p: Page, beschreibung: string): Promise<void> {
  await p.getByLabel("Beschreibung Position 1").fill(beschreibung);
  await p.getByLabel("Menge Position 1").fill("2");
  await p.getByLabel(/Einzelpreis Position 1/).fill("10,00");
}

const head = (p: Page) => p.locator(".main > .page-head");
const vorschauKnopf = (p: Page) => head(p).getByRole("button", { name: "Vorschau", exact: true });
const pfeil = (p: Page) => head(p).getByRole("button", { name: "Weitere Vorschau-Optionen" });
const seitenansicht = (p: Page) => p.getByRole("region", { name: "Vorschau", exact: true });
const dialog = (p: Page) => p.getByRole("dialog", { name: "Vorschau" });

/** Lage des Dialogs, wenn er zu Ende gefahren ist */
async function lageNachDerFahrt(p: Page): Promise<{ left: number; top: number; right: number; bottom: number }> {
  await expect.poll(() => dialog(p).evaluate((el) => getComputedStyle(el).transform)).toMatch(/^none$|^matrix\(1, 0, 0, 1, 0, 0\)$/);
  return dialog(p).evaluate((el) => {
    const { left, top, right, bottom } = el.getBoundingClientRect();
    return { left, top, right, bottom };
  });
}

async function axe(p: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page: p }).withTags(WCAG).analyze();
  return violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${v.help} → ${n.target.join(" ")}`));
}

test("Laptop: Überblendung ohne Verlust von Eingaben und Scrollposition, Fokus hinein und zurück", async ({ browser }) => {
  const page = await editor(browser, LAPTOP);
  // Ohne gespeicherte Wahl am 14-Zoll-Laptop: das Formular hat die volle Breite, Anheften wird angeboten
  await expect(seitenansicht(page)).toHaveCount(0);
  await expect(pfeil(page)).toBeVisible();
  const breite = await page.locator("#invoice-form").evaluate((form) => form.getBoundingClientRect().width);
  expect(breite).toBeGreaterThan(1000);

  await position(page, "Überblendung prüfen");
  await zumEnde(page);
  // Per Tastatur: click() von Playwright scrollt den Knopf im stehenden Kopf selbst „ins Bild“ und verschöbe die Seite
  await vorschauKnopf(page).focus();
  const scrollY = await page.evaluate(() => window.scrollY);
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByLabel("Vorschau der Rechnung")).toContainText("Überblendung prüfen");
  // Seitenleiste am rechten Rand über die ganze Höhe, links bleibt das abgedunkelte Formular sichtbar
  const lage = await lageNachDerFahrt(page);
  expect(lage.right).toBe(LAPTOP.width);
  expect(lage.top).toBe(0);
  expect(lage.bottom).toBe(LAPTOP.height);
  expect(lage.left).toBeGreaterThanOrEqual(96);
  // Das Blatt scrollt unter dem Kopf und schneidet an den runden Ecken ab, statt über sie zu laufen
  expect(await dialog(page).evaluate((el) => getComputedStyle(el).overflow)).toBe("hidden");
  // Modal: der Fokus steht im Dialog, der Rest der Seite ist nicht bedienbar
  expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
  expect(await axe(page), "Überblendung").toEqual([]);

  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(vorschauKnopf(page)).toBeFocused();
  await expect(page.getByLabel("Beschreibung Position 1")).toHaveValue("Überblendung prüfen");
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);

  // Auch der Knopf „Schließen“ und ein Klick neben das Blatt schließen
  await vorschauKnopf(page).click();
  await dialog(page).getByRole("button", { name: "Schließen" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await vorschauKnopf(page).click();
  await page.mouse.click(4, LAPTOP.height - 4);
  await expect(dialog(page)).toHaveCount(0);
  await expect(vorschauKnopf(page)).toBeFocused();
  await page.context().close();
});

test("Laptop: per Tastatur anheften, steht beim Scrollen fest, bleibt nach Neuladen, Vergrößern und Ausblenden", async ({ browser }) => {
  const page = await editor(browser, LAPTOP);
  await position(page, "Angeheftet prüfen");

  // Menü nach WAI-ARIA: Enter öffnet und setzt den Fokus auf den ersten Eintrag, Escape schließt zurück auf den Pfeil
  await pfeil(page).focus();
  await page.keyboard.press("Enter");
  await expect(pfeil(page)).toHaveAttribute("aria-expanded", "true");
  const eintrag = page.getByRole("menuitem", { name: "Neben Formular anheften" });
  await expect(eintrag).toBeFocused();
  expect(await axe(page), "Menü offen").toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(pfeil(page)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(eintrag).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(seitenansicht(page)).toBeVisible();
  await expect(pfeil(page)).toHaveAttribute("aria-expanded", "false");
  await expect(pfeil(page)).toBeFocused();
  await expect(seitenansicht(page).getByLabel("Vorschau der Rechnung")).toContainText("Angeheftet prüfen");
  await expect(page.getByLabel("Beschreibung Position 1")).toHaveValue("Angeheftet prüfen");
  // Formular und Vorschau nebeneinander, das Formular behält seine Mindestbreite (FORM_MIN_WIDTH)
  const [form, pane] = await Promise.all([page.locator("#invoice-form").boundingBox(), seitenansicht(page).boundingBox()]);
  expect(pane!.x).toBeGreaterThan(form!.x + form!.width);
  expect(form!.width).toBeGreaterThanOrEqual(640);

  // Beim Scrollen steht sie unter dem Kopf, das Blatt scrollt in ihrem eigenen Bereich
  await zumEnde(page);
  await sichtbar(seitenansicht(page).getByRole("button", { name: "Ausblenden" }));
  expect(await seitenansicht(page).evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual((await kopfUnterkante(page)) - 1);
  expect(await seitenansicht(page).evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(LAPTOP.height);
  const body = seitenansicht(page).locator(".preview-pane-body");
  expect(await body.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
  // Eine einzelne Seite passt am Laptop gerade in die Karte; im niedrigeren Fenster muss sie in sich scrollen
  await page.setViewportSize({ width: LAPTOP.width, height: 560 });
  await expect.poll(() => body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // Verlauf nur an der Kante, hinter der es weitergeht; voll, sobald die Blattkante den Rand erreicht
  const verlauf = (kante: string) => body.evaluate((el, name) => Number((el.parentElement as HTMLElement).style.getPropertyValue(name)), kante);
  await expect.poll(() => verlauf("--fade-bottom")).toBe(1);
  expect(await verlauf("--fade-top")).toBe(0);
  await body.evaluate((el) => el.scrollTo(0, 6));
  await expect.poll(() => verlauf("--fade-top")).toBeGreaterThan(0);
  expect(await verlauf("--fade-top")).toBeLessThan(1);
  // Voll, sobald um den Innenabstand gescrollt ist, also die Blattkante am Rand steht
  await body.evaluate((el) => el.scrollTo(0, parseFloat(getComputedStyle(el).paddingTop)));
  await expect.poll(() => verlauf("--fade-top")).toBe(1);
  await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect.poll(() => verlauf("--fade-bottom")).toBe(0);
  expect(await verlauf("--fade-top")).toBe(1);
  await body.evaluate((el) => el.scrollTo(0, 0));
  // Scrollt es, ist der Bereich per Tastatur erreichbar (WCAG 2.1.1)
  await expect(body).toHaveAttribute("tabindex", "0");
  expect(await axe(page), "angeheftet").toEqual([]);
  await page.setViewportSize(LAPTOP);

  // Je Gerät gemerkt
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(seitenansicht(page)).toBeVisible();
  await pfeil(page).click();
  await expect(page.getByRole("menuitem", { name: "Vorschau abheften" })).toBeVisible();
  await page.keyboard.press("Escape");

  const vergroessern = seitenansicht(page).getByRole("button", { name: "Vergrößern" });
  await vergroessern.click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(vergroessern).toBeFocused();

  await seitenansicht(page).getByRole("button", { name: "Ausblenden" }).click();
  await expect(seitenansicht(page)).toHaveCount(0);
  await expect(vorschauKnopf(page)).toBeFocused();
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(pfeil(page)).toBeVisible();
  await expect(seitenansicht(page)).toHaveCount(0);
  await page.context().close();
});

/** Zählt an <html>, wie oft die angeheftete Vorschau zu fahren beginnt; ab dem nächsten Laden */
const fahrtenZaehlen = (p: Page) =>
  p.addInitScript(() => {
    document.addEventListener(
      "transitionrun",
      (event) => {
        if (!(event.target instanceof Element) || !event.target.matches(".preview-pane")) return;
        const html = document.documentElement;
        html.dataset.fahrten = String(Number(html.dataset.fahrten ?? 0) + 1);
      },
      true,
    );
  });
const fahrten = (p: Page) => p.evaluate(() => Number(document.documentElement.dataset.fahrten ?? 0));

test("Laptop: angeheftete Vorschau fährt auf Zuruf herein und hinaus, beim Laden und ohne Bewegung nicht", async ({ browser }) => {
  const page = await editor(browser, LAPTOP);
  await fahrtenZaehlen(page);
  await page.reload();
  await page.waitForLoadState("networkidle");

  const anheften = async () => {
    await pfeil(page).click();
    await page.getByRole("menuitem", { name: "Neben Formular anheften" }).click();
    await expect(seitenansicht(page)).toBeVisible();
  };
  await anheften();
  await expect.poll(() => fahrten(page)).toBe(1);
  // Die Fahrt von rechts zieht die Seite nicht in die Breite
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  // Beim Laden steht sie einfach da
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(seitenansicht(page)).toBeVisible();
  // Eine Fahrt meldete ihren Start im Bild nach dem Setzen der Klasse
  await bilder(page);
  expect(await fahrten(page)).toBe(0);

  // Hinaus: Der Fokus geht sofort zurück, erst nach der Fahrt bekommt das Formular wieder die volle Breite
  await seitenansicht(page).getByRole("button", { name: "Ausblenden" }).click();
  await expect(vorschauKnopf(page)).toBeFocused();
  await expect.poll(() => fahrten(page)).toBe(1);
  await expect(page.locator(".preview-pane")).toHaveCount(0);
  await expect.poll(() => page.locator("#invoice-form").evaluate((form) => form.getBoundingClientRect().width)).toBeGreaterThan(1000);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await anheften();
  await seitenansicht(page).getByRole("button", { name: "Ausblenden" }).click();
  await expect(page.locator(".preview-pane")).toHaveCount(0);
  expect(await fahrten(page)).toBe(1);
  await page.context().close();
});

test("Scrollleiste, die Platz braucht (Windows, Linux): Überblendung reicht bis zum Rand, die Seite dahinter springt nicht", async () => {
  // Playwright blendet Scrollleisten sonst aus; ein eigener Browser, weil sich das je Test nicht umstellen lässt
  const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
  const page = await editor(browser, LAPTOP);
  await page.addStyleTag({ content: "html::-webkit-scrollbar { width: 15px; background: #ccc; }" });
  expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(LAPTOP.width - 15);
  const formular = () => page.locator("#invoice-form").evaluate((form) => form.getBoundingClientRect().width);
  const vorher = await formular();

  await vorschauKnopf(page).focus();
  await page.keyboard.press("Enter");
  expect((await lageNachDerFahrt(page)).right).toBe(LAPTOP.width);
  expect(await formular()).toBe(vorher);

  await page.keyboard.press("Escape");
  await expect(page.locator(".preview-dialog")).toHaveCount(0);
  expect(await formular()).toBe(vorher);
  await browser.close();
});

test("Großer Bildschirm: ohne gespeicherte Wahl angeheftet", async ({ browser }) => {
  const page = await editor(browser, GROSS);
  await expect(seitenansicht(page)).toBeVisible();
  await page.context().close();
});

test("Handy: nur Überblendung, ohne Pfeil und ohne waagrechtes Scrollen", async ({ browser }) => {
  const page = await editor(browser, HANDY);
  const vorschau = page.locator(".main > .action-bar").getByRole("button", { name: "Vorschau", exact: true });
  await expect(vorschau).toBeVisible();
  await expect(pfeil(page)).toHaveCount(0);
  await expect(seitenansicht(page)).toHaveCount(0);
  await vorschau.click();
  await expect(dialog(page)).toBeVisible();
  // Von unten über die ganze Breite, oben bleibt ein Streifen der Seite sichtbar
  const lage = await lageNachDerFahrt(page);
  expect(lage.left).toBe(0);
  expect(lage.right).toBe(HANDY.width);
  expect(lage.bottom).toBe(HANDY.height);
  expect(lage.top).toBeGreaterThan(0);
  expect(await dialog(page).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  expect(await axe(page), "Überblendung am Handy").toEqual([]);
  await dialog(page).getByRole("button", { name: "Schließen" }).click();
  await expect(vorschau).toBeFocused();
  await page.context().close();
});

test("Handy: Die Überblendung ist oben rund und lässt sich am Griff nach unten wegziehen", async ({ browser }) => {
  const page = await editor(browser, HANDY);
  const vorschau = page.locator(".main > .action-bar").getByRole("button", { name: "Vorschau", exact: true });
  await vorschau.click();
  const griff = dialog(page).locator(".sheet-grip");
  await expect(griff).toBeVisible();
  await lageNachDerFahrt(page);
  expect(await dialog(page).evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("16px");

  await ziehen(page, griff, 30);
  expect(Math.round((await dialog(page).boundingBox())!.y + (await dialog(page).boundingBox())!.height)).toBe(HANDY.height + 30);
  await page.mouse.up();
  await expect(dialog(page)).toBeVisible();
  expect(Math.round((await dialog(page).boundingBox())!.y + (await dialog(page).boundingBox())!.height)).toBe(HANDY.height);

  await ziehen(page, dialog(page).getByRole("heading", { name: "Vorschau" }), 120);
  await page.mouse.up();
  await expect(dialog(page)).toHaveCount(0);
  await expect(vorschau).toBeFocused();
  await page.context().close();
});

test("Laptop: Die Überblendung zeigt keinen Griff", async ({ browser }) => {
  const page = await editor(browser, LAPTOP);
  await vorschauKnopf(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator(".sheet-grip")).toBeHidden();
  await page.context().close();
});

test("Angebot: dieselbe Vorschau", async ({ browser }) => {
  const page = await editor(browser, LAPTOP, "/angebote/neu");
  await vorschauKnopf(page).click();
  await expect(dialog(page).getByLabel("Vorschau des Angebots")).toBeVisible();
  await page.keyboard.press("Escape");
  await pfeil(page).click();
  await page.getByRole("menuitem", { name: "Neben Formular anheften" }).click();
  await expect(seitenansicht(page).getByLabel("Vorschau des Angebots")).toBeVisible();
  await page.context().close();
});

/** Fehlerseite von nginx, wenn Haben dahinter gerade neu startet */
const NGINX_502 = "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n</body>\r\n</html>";

for (const fall of [
  { name: "Abgebrochene Anfrage, Laptop, hell", viewport: LAPTOP, modus: undefined, antwort: (route: Route) => route.abort("internetdisconnected") },
  {
    name: "Fehlerseite des Proxys, Handy, dunkel",
    viewport: HANDY,
    modus: "dunkel" as const,
    antwort: (route: Route) => route.fulfill({ status: 502, contentType: "text/html", body: NGINX_502 }),
  },
]) {
  test(`${fall.name}: deutsche Meldung als Status, „Erneut versuchen“ setzt das Blatt (#1147)`, async ({ browser }) => {
    const page = await editor(browser, fall.viewport, "/rechnungen/neu", fall.modus);
    // Nur die Anfrage der Vorschau (Stand des Formulars mit Positionen) scheitert, wie bei einem Server, der nicht antwortet
    await page.route(
      (url) => url.pathname.startsWith("/_serverFn/"),
      (route) => (route.request().method() === "POST" && route.request().postData()?.includes("lines") ? fall.antwort(route) : route.fallback()),
    );
    await page.getByRole("button", { name: "Vorschau", exact: true }).click();
    const blatt = dialog(page).getByLabel("Vorschau der Rechnung");
    const meldung = blatt.getByRole("status").filter({ hasText: "Die Vorschau ließ sich nicht erzeugen." });
    await expect(meldung).toHaveText(/^Die Vorschau ließ sich nicht erzeugen\. Haben ist gerade nicht erreichbar\.\s*Erneut versuchen$/);
    // Sie entsteht beim Tippen: kein alert, der eine Meldung zum Speichern übertönt (DESIGN.md)
    await expect(blatt.getByRole("alert")).toHaveCount(0);
    expect(await axe(page), "Meldung der Vorschau").toEqual([]);

    await page.unrouteAll({ behavior: "wait" });
    await meldung.getByRole("button", { name: "Erneut versuchen" }).click();
    await expect(meldung).toHaveCount(0);
    await expect(blatt.getByRole("img", { name: /^Seite 1 von/ })).toBeVisible();
    await page.context().close();
  });
}

test("Gesperrter Speicher: Der Editor öffnet, Anheften gilt bis zum Neuladen", async ({ browser }) => {
  // Chrome mit gesperrten Websitedaten wirft schon beim Zugriff auf window.localStorage, nicht erst bei getItem
  const state = JSON.parse(readFileSync(SESSION, "utf8")) as { cookies: [] };
  const context = await browser.newContext({ viewport: LAPTOP, storageState: { cookies: state.cookies, origins: [] } });
  await context.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
    });
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/rechnungen/neu");
  await page.waitForLoadState("networkidle");
  await expect(page.getByLabel("Beschreibung Position 1")).toBeVisible();
  await pfeil(page).click();
  await page.getByRole("menuitem", { name: "Neben Formular anheften" }).click();
  await expect(seitenansicht(page)).toBeVisible();
  expect(pageErrors).toEqual([]);
  await context.close();
});

test("Überblendung: Das Mausrad bewegt die Seite dahinter nicht", async ({ browser }) => {
  const page = await editor(browser, LAPTOP);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeGreaterThan(200);
  await vorschauKnopf(page).click();
  await lageNachDerFahrt(page);
  await page.mouse.move(4, 400);
  await page.mouse.wheel(0, 600);
  // Ein Bildlauf begänne in den Bildern nach dem Rad (auch der weiche)
  await bilder(page, 3);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.context().close();
});

test("Überblendung: Eine Textauswahl, die neben dem Blatt endet, schließt sie nicht", async ({ browser }) => {
  const page = await editor(browser, LAPTOP);
  await vorschauKnopf(page).click();
  const lage = await lageNachDerFahrt(page);
  // Der Browser meldet den Klick am gemeinsamen Vorfahren von Drücken und Loslassen: dem Dialog, wie beim Klick daneben
  await page.mouse.move(lage.left + 200, 400);
  await page.mouse.down();
  await page.mouse.move(4, 400, { steps: 5 });
  await page.mouse.up();
  // Der Klick schlösse den Dialog sofort (close()), auch wenn er danach noch hinausfährt
  await abgearbeitet(page);
  expect(await page.locator("dialog.preview-dialog").evaluate((el: HTMLDialogElement) => el.open)).toBe(true);
  await page.context().close();
});

test("Menü: Ein Klick auf „Vorschau“ schließt es", async ({ browser }) => {
  const page = await editor(browser, LAPTOP);
  await pfeil(page).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await vorschauKnopf(page).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(pfeil(page)).toHaveAttribute("aria-expanded", "false");
  await page.context().close();
});

test("Überblendung: Der Fokus kehrt zurück, auch wenn der Browser Knöpfe beim Klick nicht fokussiert", async ({ browser }) => {
  const page = await editor(browser, LAPTOP);
  // Safari und Firefox auf dem Mac: Der Klick lässt den Fokus auf <body>; in Chromium nachgestellt
  await vorschauKnopf(page).evaluate((button) => {
    (document.activeElement as HTMLElement | null)?.blur();
    (button as HTMLElement).click();
  });
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(vorschauKnopf(page)).toBeFocused();
  await page.context().close();
});

test("Laptop: Der Fokus bleibt auf „Vorschau“, wenn der Pfeil beim Verkleinern entfällt", async ({ browser }) => {
  const page = await editor(browser, LAPTOP);
  await expect(pfeil(page)).toBeVisible();
  await vorschauKnopf(page).focus();
  // Auch Browser-Zoom ändert die Breite (WCAG 1.4.4); der Knopf darf dabei nicht neu aufgebaut werden
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(pfeil(page)).toHaveCount(0);
  // Unter 861 px steht „Vorschau“ in der Aktionsleiste (#396, #355 Variante E); der Fokus geht mit und beim Vergrößern zurück
  const inDerLeiste = page.locator(".main > .action-bar").getByRole("button", { name: "Vorschau", exact: true });
  await expect(inDerLeiste).toBeFocused();
  await page.setViewportSize(LAPTOP);
  await expect(vorschauKnopf(page)).toBeFocused();
  await page.context().close();
});

test("Überblendung: Ein Fokus, den man während der Fahrt hinaus setzt, bleibt", async ({ browser }) => {
  const page = await editor(browser, LAPTOP);
  await vorschauKnopf(page).click();
  await lageNachDerFahrt(page);
  await page.keyboard.press("Escape");
  // Die Leiste fährt noch; wer schon ins Formular klickt, tippt sonst ins Leere
  const feld = page.getByLabel("Beschreibung Position 1");
  await feld.focus();
  await expect(dialog(page)).toHaveCount(0);
  // Nach der Fahrt ist der Dialog aus dem DOM; dann darf der Fokus nicht zurückspringen
  await expect(page.locator("dialog.preview-dialog")).toHaveCount(0);
  await abgearbeitet(page);
  await expect(feld).toBeFocused();
  await page.context().close();
});
