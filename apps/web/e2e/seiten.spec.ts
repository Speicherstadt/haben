import { expect, type Page, test } from "@playwright/test";
import { day, fakeEigeneSeite, firstLink, SESSION, YEAR } from "./daten.ts";

/**
 * Lädt jede Seite (Desktop und Handy) mit den Daten aus app.spec.ts: Jede Seite muss laden, eine Überschrift
 * haben und darf auf dem Handy nicht breiter sein als der Bildschirm. Eine neue Seite gehört in ROUTES.
 * Bilder für README und Doku macht zz-doku-screenshots.spec.ts.
 */

test.use({ storageState: SESSION });

async function routes(page: Page): Promise<[string, string | null][]> {
  const details = {
    rechnung: await firstLink(page, "/rechnungen", /^\/rechnungen\/[0-9a-f-]{36}$/),
    beleg: await firstLink(page, "/belege", /^\/belege\/[0-9a-f-]{36}$/),
    kontakt: await firstLink(page, "/kontakte", /^\/kontakte\/[0-9a-f-]{36}$/),
    eigeneSeite: await firstLink(page, "/einstellungen?bereich=seiten", /^\/seiten\/[0-9a-f-]{36}$/),
    mitarbeiter: await firstLink(page, "/lohn", /^\/lohn\/mitarbeiter\/[0-9a-f-]{36}$/),
    dauerbeleg: await firstLink(page, "/dauerbelege", /^\/dauerbelege\/[0-9a-f-]{36}$/),
  };
  const month = Number(day(-12).slice(5, 7));
  return [
    ["uebersicht", "/"],
    ["rechnungen", "/rechnungen"],
    ["rechnung-neu", "/rechnungen/neu"],
    ["angebote", "/angebote"],
    ["rechnung", details.rechnung],
    ["mahnwesen", "/rechnungen/mahnwesen"],
    ["wiederkehrend", "/rechnungen/wiederkehrend"],
    ["lastschriften", "/lastschriften"],
    ["artikel", "/artikel"],
    ["leistungen", "/leistungen"],
    ["textbausteine", "/textbausteine"],
    ["belege", "/belege"],
    ["beleg", details.beleg],
    ["dauerbelege", "/dauerbelege"],
    ["dauerbeleg-neu", "/dauerbelege/neu"],
    ["dauerbeleg", details.dauerbeleg],
    ["ueberweisungen", "/ueberweisungen"],
    ["pauschalen", "/pauschalen"],
    ["kasse", "/kasse"],
    ["darlehen", "/darlehen"],
    ["bank", "/bank"],
    ["bank-verbinden", "/bank/verbinden/stripe"],
    ["bank-verbindungen", "/bank/verbindungen"],
    ["anlagen", "/anlagen"],
    ["anlage-neu", "/anlagen/neu"],
    ["csv-import", "/csv-import?art=kontakte"],
    ["buchungen", `/buchungen?jahr=${YEAR}&monat=${month}`],
    ["buchung-erfassen", "/buchungen/neu"],
    ["jahresabschluss", `/abschluss/${YEAR - 1}`],
    ["ausschuettungen", "/ausschuettungen"],
    ["lohnsteuerbescheinigung", `/lohn/bescheinigung/${YEAR}`],
    ["lohn", "/lohn"],
    ["mitarbeiter-neu", "/lohn/mitarbeiter/neu"],
    ["lohnsteuer-anmeldung", `/lohn/anmeldung/${YEAR}`],
    ["mitarbeiter", details.mitarbeiter],
    ["sv-meldeportal", "/sv-meldeportal"],
    ["konten", `/konten?jahr=${YEAR}`],
    ["kontenblatt", `/konten/1200?jahr=${YEAR}`],
    ["umsatzsteuer", "/umsatzsteuer"],
    ["zusammenfassende-meldung", `/umsatzsteuer/zm/${YEAR + 1}-Q1`],
    ["jahreserklaerung", `/jahreserklaerung/${YEAR - 1}`],
    ["finanzamt", "/finanzamt"],
    ["fristen", "/fristen"],
    ["auswertungen", "/auswertungen"],
    ["bwa", `/auswertungen/bwa?jahr=${YEAR}&zeitraum=jahr`],
    ["liquiditaet", "/auswertungen/liquiditaet?horizont=12m"],
    ["kontakte", "/kontakte"],
    ["kontakt", details.kontakt],
    ["archiv", "/archiv"],
    ["archiv-auftraege", "/archiv?ansicht=auftraege"],
    ["archiv-auftrag", "/archiv/auftrag/723bf34b-f8ab-48f0-b391-656af4b72a96"],
    ["einstellungen", "/einstellungen"],
    ["einstellungen-bereiche", "/einstellungen?bereich=bereiche"],
    ["einrichtung", "/einrichtung"],
    ["einstellungen-gestaltung", "/einstellungen?bereich=gestaltung"],
    ["einstellungen-elster", "/einstellungen?bereich=elster"],
    ["einstellungen-email", "/einstellungen?bereich=email"],
    ["einstellungen-bank", "/einstellungen?bereich=bank"],
    ["einstellungen-ki", "/einstellungen?bereich=ki"],
    ["einstellungen-export", "/einstellungen?bereich=export"],
    ["verfahrensdokumentation", "/einstellungen/verfahrensdokumentation"],
    ["einstellungen-konten", "/einstellungen?bereich=konten"],
    ["einstellungen-seiten", "/einstellungen?bereich=seiten"],
    ["einstellungen-sicherheit", "/einstellungen?bereich=sicherheit"],
    ["steuerberatung", "/steuerberatung"],
    ["eigene-seite", details.eigeneSeite],
  ];
}

/** Zwei Hälften je Gerät, damit sich die Seiten auf die Worker verteilen */
const HALVES = [0, 1] as const;

for (const [device, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["mobil", { width: 390, height: 844 }],
] as const) {
  for (const half of HALVES) {
    test(`Alle Seiten laden (${device}, Teil ${half + 1})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await fakeEigeneSeite(page);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const all = await routes(page);
      const middle = Math.ceil(all.length / 2);
      for (const [index, [, path]] of all.entries()) {
        if (!path || index < middle !== (half === 0)) continue;
        const response = await page.goto(path);
        expect(response?.status(), `${path} lädt`).toBeLessThan(400);
        // Erst wenn das Netz ruht, ist die Seite hydriert; sonst entgingen späte Fehler im Browser (pageerror)
        await page.waitForLoadState("networkidle");
        await expect(page.getByRole("heading", { level: 1 }).first(), `${path} hat eine Überschrift`).toBeVisible();
        // Kein waagrechtes Scrollen der ganzen Seite und keine abgeschnittenen Kopf-Aktionen auf dem Handy (#1790)
        if (device === "mobil") {
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect.soft(overflow, `${path} ist nicht breiter als das Handy`).toBeLessThanOrEqual(1);
          const kopfUeberlauf = await page.evaluate(() => {
            const act = document.querySelector(".page-head .actions");
            if (!act || getComputedStyle(act).display === "none") return 0;
            return act.scrollWidth - act.clientWidth;
          });
          expect.soft(kopfUeberlauf, `${path}: Aktionen im Seitenkopf ragen nicht aus dem Bild`).toBeLessThanOrEqual(1);
        }
      }
      if (device === "mobil" && half === 1) {
        // Menü auf dem Handy: aufklappen, Seite wählen, schließt wieder
        await page.goto("/");
        await page.waitForLoadState("networkidle");
        await page.getByRole("button", { name: "Menü" }).click();
        await expect(page.getByRole("link", { name: "Konten" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Dokumentation" })).toHaveAttribute("href", "https://haben.app/");
        await page.getByRole("link", { name: "Konten" }).click();
        await page.waitForURL(/\/konten/);
        await expect(page.getByRole("link", { name: "Einstellungen" })).toBeHidden();
      }
      expect(errors, `Fehler im Browser (${device})`).toEqual([]);
    });
  }
}

/** Gültige UUID, zu der es nichts gibt */
const UNBEKANNT = "00000000-0000-4000-8000-000000000000";

test("Unbekannter Datensatz oder kaputte Adresse: 404 mit deutscher Seite im Layout", async ({ page }) => {
  const detailseiten = [
    "/belege",
    "/rechnungen",
    "/kontakte",
    "/angebote",
    "/anlagen",
    "/dauerbelege",
    "/rechnungen/wiederkehrend",
    "/archiv/beleg",
    "/archiv/auftrag",
    "/lohn/mitarbeiter",
    "/seiten",
  ];
  for (const path of [...detailseiten.flatMap((seite) => [`${seite}/${UNBEKANNT}`, `${seite}/kaputt`]), "/rechnungen/mahnwesen/kaputt", "/abschluss/1999"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "Seite nicht gefunden" }), path).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Hauptnavigation" }), path).toBeVisible();
  }
  await page.getByRole("link", { name: "Zur Übersicht" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("Mahnung zu einer unbekannten Rechnung: 404 wie bei den anderen Detailseiten", async ({ page }) => {
  const response = await page.goto(`/rechnungen/mahnwesen/${UNBEKANNT}`);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "Seite nicht gefunden" })).toBeVisible();
});

test("Ungültiger Wert in der Adresse: deutsche Fehlerseite statt englischer Meldung", async ({ page }) => {
  for (const path of ["/auswertungen?jahr=1999", "/buchungen?jahr=1999&monat=1"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: "Seite konnte nicht geladen werden" }), path).toBeVisible();
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
  }
});

test("Jahreswechsler der Auswertungen: jedes Jahr höchstens einmal, Vor- und Folgejahr per Pfeil", async ({ page }) => {
  // Das Vorjahr von heute: Das laufende Jahr steht immer in der Liste und ist zugleich das Folgejahr
  const jahr = new Date().getFullYear() - 1;
  await page.goto(`/auswertungen?jahr=${jahr}`);
  const nav = page.getByRole("navigation", { name: "Jahr wählen" });
  const texte = await nav.getByRole("link").allInnerTexts();
  const jahre = texte.flatMap((t) => t.match(/\d{4}/g) ?? []);
  expect(jahre.length, texte.join(" · ")).toBeGreaterThan(0);
  expect(new Set(jahre).size, texte.join(" · ")).toBe(jahre.length);
  await expect(nav.getByRole("link", { name: `Vorjahr ${jahr - 1}` })).toHaveAttribute("href", `/auswertungen?jahr=${jahr - 1}`);
  await expect(nav.getByRole("link", { name: `Folgejahr ${jahr + 1}` })).toHaveAttribute("href", `/auswertungen?jahr=${jahr + 1}`);
});

test("Jahres- und Monatswechsel enden an den Grenzen der gültigen Jahre", async ({ page }) => {
  await page.goto("/auswertungen?jahr=2000");
  await expect(page.getByRole("link", { name: "Folgejahr 2001" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Vorjahr 1999" })).toHaveCount(0);
  await page.goto("/auswertungen?jahr=2100");
  await expect(page.getByRole("link", { name: "Vorjahr 2099" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Folgejahr 2101" })).toHaveCount(0);
  await page.goto("/buchungen?jahr=2000&monat=1");
  await expect(page.getByRole("link", { name: /1999/ })).toHaveCount(0);
  await page.goto("/buchungen?jahr=2100&monat=12");
  await expect(page.getByRole("link", { name: /2101/ })).toHaveCount(0);
});

test("Tablet (768 px, 861 px) und schmales Handy (320 px): kein Überlauf und keine Überlappung", async ({ page }) => {
  const month = Number(day(-12).slice(5, 7));
  const tabletSeiten = [
    "/rechnungen",
    "/belege",
    "/dauerbelege",
    `/buchungen?jahr=${YEAR}&monat=${month}`,
    "/buchungen/neu",
    `/konten/1200?jahr=${YEAR}`,
    `/auswertungen/bwa?jahr=${YEAR}&zeitraum=jahr`,
    "/auswertungen/liquiditaet?horizont=12m",
    "/einstellungen?bereich=rechnungen",
  ];
  for (const viewport of [
    { width: 768, height: 1024 },
    { width: 861, height: 1100 },
  ]) {
    await page.setViewportSize(viewport);
    for (const pfad of tabletSeiten) {
      await page.goto(pfad);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect.soft(overflow, `${pfad} bei ${viewport.width}px ohne Seitenüberlauf`).toBeLessThanOrEqual(1);
    }
  }
  // Zahlungsplan-Vorlagen in Einstellungen › Rechnungen: Auswahl „%/€ netto“ überlappt kein Nachbarfeld
  await page.setViewportSize({ width: 861, height: 1100 });
  await page.goto("/einstellungen?bereich=rechnungen");
  await page.waitForLoadState("networkidle");
  const planUeberlappungen = await page.evaluate(() => {
    const treffer: string[] = [];
    for (const row of document.querySelectorAll(".plan-row")) {
      const felder = [...row.querySelectorAll<HTMLElement>("input, select")].filter((el) => el.getBoundingClientRect().width > 0);
      for (let i = 0; i < felder.length; i++) {
        const a = felder[i]!.getBoundingClientRect();
        for (let j = i + 1; j < felder.length; j++) {
          const b = felder[j]!.getBoundingClientRect();
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 3 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 3) {
            treffer.push(`${felder[i]!.tagName} überlappt ${felder[j]!.tagName}`);
          }
        }
      }
    }
    return treffer;
  });
  expect(planUeberlappungen, "Zahlungsplan-Vorlagen bei 861px ohne Überlappung").toEqual([]);

  // Schmales Handy (320 px, WCAG 1.4.10): lange Code-URLs laufen nicht aus dem Bild, versteckte Spaltenköpfe breiter
  // Tabellen (Archiv › Offene Posten) nicht aus ihrem Rollbereich, Kurzwerte der Jahreserklärung nicht aus ihrem Block
  await page.setViewportSize({ width: 320, height: 640 });
  for (const pfad of ["/einstellungen?bereich=bank", "/archiv", `/jahreserklaerung/${YEAR - 1}`]) {
    await page.goto(pfad);
    await page.waitForLoadState("networkidle");
    const overflow320 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect.soft(overflow320, `${pfad} bei 320px ohne Seitenüberlauf`).toBeLessThanOrEqual(1);
  }
});

test("Kontosuche auf /buchungen/neu wird bei Tablet-Breite nicht abgeschnitten", async ({ page }) => {
  await page.setViewportSize({ width: 861, height: 1100 });
  await page.goto("/buchungen/neu");
  await page.waitForLoadState("networkidle");
  const input = page.locator(".account-combobox input[role='combobox']").first();
  await input.click();
  const popup = page.locator(".account-combobox .combobox-popup").first();
  await expect(popup).toBeVisible();
  const clip = await page.evaluate(() => {
    const p = document.querySelector<HTMLElement>(".account-combobox .combobox-popup");
    const t = p?.closest("table");
    if (!p || !t) return null;
    const pRect = p.getBoundingClientRect();
    const tRect = t.getBoundingClientRect();
    const cs = getComputedStyle(t);
    return {
      overflowY: cs.overflowY,
      popupBottom: Math.round(pRect.bottom),
      tableBottom: Math.round(tRect.bottom),
      clippedPx: cs.overflowY !== "visible" ? Math.round(pRect.bottom - tRect.bottom) : 0,
    };
  });
  expect(clip?.clippedPx ?? 0, `Combobox-Liste abgeschnitten: ${JSON.stringify(clip)}`).toBeLessThanOrEqual(0);
});

test("Spalten in /rechnungen, /belege, /dauerbelege bei 861 px ohne Überlappung", async ({ page }) => {
  await page.setViewportSize({ width: 861, height: 1100 });
  for (const pfad of ["/rechnungen", "/belege", "/dauerbelege"]) {
    await page.goto(pfad);
    await page.waitForLoadState("networkidle");
    const fehler = await page.evaluate(() => {
      const out: string[] = [];
      for (const row of document.querySelectorAll<HTMLElement>(".table-row")) {
        const zellen = [...row.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el.getBoundingClientRect().width > 0);
        for (const z of zellen) {
          if (z.scrollWidth > z.clientWidth + 2 && getComputedStyle(z).overflowX === "visible") {
            out.push(`Zelle läuft über (${z.scrollWidth} > ${z.clientWidth}): "${z.textContent?.trim().slice(0, 30)}"`);
          }
        }
      }
      return out;
    });
    expect(fehler, `${pfad} bei 861px ohne überlaufende Spaltenzellen`).toEqual([]);
  }
});

test("Beleg am Handy: Blättern in einer Zeile, Position mittig, nichts ragt aus dem Bild", async ({ page }) => {
  const beleg = await firstLink(page, "/belege", /^\/belege\/[0-9a-f-]{36}$/);
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(beleg!);
    const blaettern = page.getByRole("group", { name: "Zwischen Belegen wechseln" });
    await expect(blaettern.getByRole("button", { name: /Nächster/ })).toBeVisible();
    const [vor, position, weiter] = await Promise.all([
      blaettern.getByRole("button", { name: /Vorheriger/ }).boundingBox(),
      blaettern.getByText(/^\d+ von \d+$/).boundingBox(),
      blaettern.getByRole("button", { name: /Nächster/ }).boundingBox(),
    ]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `Beleg bei ${width}px ohne Seitenüberlauf`).toBeLessThanOrEqual(1);
    expect(weiter!.x + weiter!.width, `„Nächster“ bei ${width}px im Bild`).toBeLessThanOrEqual(width - 16 + 1);
    // Eine Zeile: Zurück, Position und Weiter auf einer Höhe; die Position steht in der Mitte der Seite
    expect(Math.abs(vor!.y - weiter!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(position!.x + position!.width / 2 - width / 2), `Position bei ${width}px mittig`).toBeLessThanOrEqual(2);
  }
});
