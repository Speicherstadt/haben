import { kategorieName, waehleKategorie } from "./kategorie.ts";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, type Page, type Route, test } from "@playwright/test";
import postgres from "postgres";
import { day, YEAR } from "./daten.ts";
import { type Durchlauf, databaseUrlFuer } from "./durchlaeufe.ts";
import {
  bestaetigen,
  durchlaufSeite,
  gehe,
  lieferantWaehlen,
  neuenLieferantenOeffnen,
  weitereAngabenOeffnen,
  ohneAxeVerstoesse,
  trefferliste,
  ueberSchnellsuche,
} from "./einrichtung.ts";
import { LAPTOP, sichtbar } from "./kopfzeile.ts";
import { abzugEinspielen } from "./abzug.ts";
import { receiptJpeg } from "./belegbild.ts";
import { vorsteuerPruefen } from "./belege-vorsteuer.ts";
import { serverAufrufe } from "./warten.ts";
import { eingabeNachAktion, fokusNachFehlschlag, gesperrtBisNeuGeladen, kurzNacheinanderSpeichern } from "./felder-sperre.ts";

/**
 * Abschnitt von belege-steuern (#1742) mit eigenem Server und eigener Datenbank, parallel zu den anderen Abschnitten:
 * Belege erfassen und prüfen: Kategorie per Suche, Beleg wechseln, § 13b, Brutto und Netto, Aufteilung, Lieferanten,
 * Vorsteueranteile, „Ohne Vorsteuerabzug“, eigene Konten und „Weitere Angaben“. Beginnt mit dem Abzug nach Einrichtung
 * und Steuerdaten in belege-steuern.spec.ts (e2e/abzug.ts).
 */

const DURCHLAUF = "belege-steuern-belege" satisfies Durchlauf;

test.describe.configure({ mode: "serial" });

let page: Page;
let pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  ({ page, pageErrors } = await durchlaufSeite(browser, await abzugEinspielen("belege-steuern", DURCHLAUF)));
});

test.afterAll(async () => {
  await page.context().close();
});

const go = (path: string) => gehe(page, path);

test("Beleg prüfen: Ein Fehler beim Speichern steht nicht hinter den stehenden Knöpfen (#356)", async ({ browser }) => {
  const vorher = page.viewportSize();
  await page.setViewportSize(LAPTOP);
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "meldung.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Funknetz Mobil GmbH") }]);
  await expect(page.getByText("meldung.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /meldung\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Lieferant", { exact: true }).fill("Funknetz Mobil GmbH");
  await page.getByLabel("Rechnungsnummer").fill("MF-0816");
  await page.getByLabel("Belegdatum").fill(day(-9));
  await waehleKategorie(page.getByLabel("Kategorie"), "telefon");
  await page.getByLabel("Netto", { exact: true }).fill("38,57");
  // Oben im Formular, das in seiner Spalte scrollt; nur dann stehen die Knöpfe über dessen Ende
  const spalte = page.locator(".doc-editor > .stack");
  await spalte.evaluate((el) => el.scrollTo(0, 0));
  expect(await spalte.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(200);
  const abbrechen = (route: Route) => (route.request().method() === "POST" ? route.abort() : route.continue());
  await page.route(/_serverFn/, abbrechen);
  await page.locator(".doc-actions").getByRole("button", { name: "Speichern" }).click();
  await sichtbar(page.locator(".doc-editor .banner-danger"));
  await page.unroute(/_serverFn/, abbrechen);
  // Der Beleg gehört nur diesem Test: die folgenden zählen die offenen Belege
  await page.locator(".doc-actions").getByRole("button", { name: "Löschen" }).click();
  await bestaetigen(page, "Beleg löschen");
  await page.waitForURL(/\/belege$/);
  if (vorher) await page.setViewportSize(vorher);
});

test("Beleg wechseln: J/K, Pfeiltasten und Wischen springen zum Nachbarn, ungespeicherte Änderungen fragen erst nach", async ({ browser }) => {
  await go("/belege");
  // Verschiedene Bilder, sonst legt Haben den zweiten Beleg nicht doppelt ab
  for (const [name, titel] of [
    ["wechsel-1.jpg", "Funknetz Mobil GmbH"],
    ["wechsel-2.jpg", "Bürobedarf Nord GmbH"],
  ] as const) {
    await page.locator("input[type=file][multiple]").setInputFiles([{ name, mimeType: "image/jpeg", buffer: await receiptJpeg(browser, titel) }]);
    await expect(page.getByText(`${name}: abgelegt.`)).toBeVisible();
  }
  // Ohne Belegdatum steht der zuletzt hochgeladene oben in der Liste
  await page
    .getByRole("link", { name: /wechsel-2\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  const datei = page.locator(".page-head .eyebrow");
  const position = page.getByRole("group", { name: "Zwischen Belegen wechseln" }).locator(".small");
  const ueberschrift = page.locator(".page-head h1");
  await expect(datei).toContainText("wechsel-2.jpg");
  await expect(position).toHaveText(/^1 von /);
  for (const [taste, ziel] of [
    ["j", "wechsel-1.jpg"],
    ["k", "wechsel-2.jpg"],
    ["ArrowRight", "wechsel-1.jpg"],
    ["ArrowLeft", "wechsel-2.jpg"],
  ] as const) {
    await ueberschrift.click();
    await page.keyboard.press(taste);
    await expect(datei).toContainText(ziel);
  }
  await expect(position).toHaveText(/^1 von /);

  // Am Handy: nach links wischen zum nächsten, nach rechts zum vorigen Beleg
  const wischen = (dx: number) =>
    ueberschrift.evaluate((el, dx) => {
      const punkt = (x: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 200 });
      el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [punkt(200)] }));
      el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, changedTouches: [punkt(200 + dx)] }));
    }, dx);
  await wischen(-120);
  await expect(datei).toContainText("wechsel-1.jpg");
  await expect(position).toHaveText(/^2 von /);
  await wischen(120);
  await expect(datei).toContainText("wechsel-2.jpg");

  // Im Eingabefeld bleibt „j“ ein Buchstabe; danach fragt der Wechsel erst nach
  const nummer = page.getByLabel("Rechnungsnummer");
  await nummer.press("j");
  await expect(nummer).toHaveValue("j");
  await expect(datei).toContainText("wechsel-2.jpg");
  await ueberschrift.click();
  await page.keyboard.press("j");
  const rueckfrage = page.getByRole("dialog", { name: "Ohne Speichern wechseln?" });
  await expect(rueckfrage).toBeVisible();
  await rueckfrage.getByRole("button", { name: "Abbrechen" }).click();
  await expect(rueckfrage).toBeHidden();
  await expect(datei).toContainText("wechsel-2.jpg");
  await expect(nummer).toHaveValue("j");
  // Esc führt zur Liste, ebenfalls erst nach der Rückfrage
  await ueberschrift.click();
  await page.keyboard.press("Escape");
  await bestaetigen(page, "Ohne Speichern wechseln");
  await page.waitForURL(/\/belege$/);

  // Die Belege gehören nur diesem Test: die folgenden zählen die offenen Belege. Nach dem Löschen geht es zum nächsten offenen
  await page
    .getByRole("link", { name: /wechsel-2\.jpg/ })
    .first()
    .click();
  for (const ziel of ["wechsel-2.jpg", "wechsel-1.jpg"]) {
    await expect(datei).toContainText(ziel);
    await page.locator(".doc-actions").getByRole("button", { name: "Löschen" }).click();
    await bestaetigen(page, "Beleg löschen");
  }
  await page.waitForURL(/\/belege$/);
});

test("Beleg prüfen: Kategorie per Suche wählen, auch ohne Umlaute, mit Tastatur und ohne Treffer", async ({ browser }) => {
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "kategoriesuche.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Funknetz Mobil GmbH") }]);
  await expect(page.getByText("kategoriesuche.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /kategoriesuche\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  const kategorie = page.getByLabel("Kategorie");
  // Ein Klick zeigt die ganze Liste, Tippen grenzt sie ein; „burobedarf“ findet auch „Bürobedarf“
  await kategorie.click();
  await expect(trefferliste(page).getByRole("option")).not.toHaveCount(1);
  await kategorie.fill("burobedarf");
  // Der Treffer nennt neben dem Namen die Gruppe (#1253)
  await expect(trefferliste(page).getByRole("option")).toHaveText([/^[0-9]{4} · Bürobedarf\s*Büro und IT$/]);
  await kategorie.press("Enter");
  await expect(kategorie).toHaveValue(kategorieName("buero"));
  // Pfeiltasten bewegen durch die Treffer, Enter übernimmt den markierten (der erste ist vorgewählt)
  await kategorie.fill("kfz");
  await kategorie.press("ArrowDown");
  await kategorie.press("Enter");
  await expect(kategorie).toHaveValue(kategorieName("kfzReparatur"));
  // Escape schließt die Liste; wer dann weitergeht, behält die bisherige Kategorie
  await kategorie.fill("hosting");
  await expect(trefferliste(page)).toBeVisible();
  await kategorie.press("Escape");
  await expect(trefferliste(page)).toBeHidden();
  await page.keyboard.press("Tab");
  await expect(kategorie).toHaveValue(kategorieName("kfzReparatur"));
  // Tab übernimmt den ersten Treffer, wie bei Kontakt und Artikel
  await kategorie.fill("telefon");
  await kategorie.press("Tab");
  await expect(kategorie).toHaveValue(kategorieName("telefon"));
  // Mehrere Wörter in beliebiger Reihenfolge, gewählt per Klick
  await kategorie.fill("leasing kfz");
  await trefferliste(page).getByRole("option", { name: "Kfz: Leasing" }).click();
  await expect(kategorie).toHaveValue(kategorieName("kfzLeasing"));
  // Ohne Treffer sagt die Liste es; wer die Eingabe stehen lässt, behält die bisherige Kategorie
  await kategorie.fill("xyz");
  await expect(page.getByText("Keine Treffer")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(kategorie).toHaveValue(kategorieName("kfzLeasing"));
  // Ein geleertes Feld nimmt die Kategorie weg
  await kategorie.fill("");
  await page.keyboard.press("Tab");
  await expect(kategorie).toHaveValue("");
  // Der Beleg gehört nur diesem Test: die folgenden zählen die offenen Belege
  await page.locator(".doc-actions").getByRole("button", { name: "Löschen" }).click();
  await bestaetigen(page, "Beleg löschen");
  await page.waitForURL(/\/belege$/);
});

test("Beleg prüfen: Die Wahl per Suche übernimmt die Privatanteil-Vorgabe der Kategorie", async ({ browser }) => {
  const vorgabe = async (anteil: string) => {
    await go("/einstellungen");
    const firma = page.getByRole("form", { name: "Firmendaten" });
    // Der Abschnitt ist nach dem Laden zu (#1253)
    await firma.getByRole("heading", { name: "Privatanteile", exact: true }).click();
    await firma.getByLabel("Privatanteil Telefon in %").fill(anteil);
    await firma.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByText("Firmendaten gespeichert.")).toBeVisible();
    await page.waitForLoadState("networkidle");
  };
  await vorgabe("20");
  try {
    await go("/belege");
    await page
      .locator("input[type=file][multiple]")
      .setInputFiles([{ name: "privatanteil.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Funknetz Mobil GmbH") }]);
    await expect(page.getByText("privatanteil.jpg: abgelegt.")).toBeVisible();
    await page
      .getByRole("link", { name: /privatanteil\.jpg/ })
      .first()
      .click();
    await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
    await page.waitForLoadState("networkidle");
    const kategorie = page.getByLabel("Kategorie");
    const privat = page.getByLabel("Privatanteil in %", { exact: true });
    // Tippen, wieder löschen und das Feld verlassen ändert bei leerer Kategorie nichts, auch ein eingetragener Anteil bleibt
    await privat.fill("5");
    await kategorie.fill("x");
    await kategorie.fill("");
    await page.keyboard.press("Tab");
    await expect(kategorie).toHaveValue("");
    await expect(privat).toHaveValue("5");
    // Telefon hat eine Vorgabe, Bürobedarf keine: die Wahl setzt oder leert den Anteil
    await waehleKategorie(kategorie, "telefon");
    await expect(privat).toHaveValue("20");
    // Bis aufs leere Feld löschen und dieselbe Kategorie wieder wählen ändert nichts: der eigene Anteil bleibt
    await privat.fill("35");
    await kategorie.fill("");
    await waehleKategorie(kategorie, "telefon");
    await expect(privat).toHaveValue("35");
    // Leeren, etwas anderes suchen und ohne Wahl mit Escape gehen: die bisherige Kategorie bleibt
    await kategorie.fill("");
    await kategorie.pressSequentially("büro");
    await kategorie.press("Escape");
    await page.keyboard.press("Tab");
    await expect(kategorie).toHaveValue(kategorieName("telefon"));
    await expect(privat).toHaveValue("35");
    await waehleKategorie(kategorie, "buero");
    await expect(privat).toHaveValue("");
    // Der Beleg gehört nur diesem Test: die folgenden zählen die offenen Belege
    await page.locator(".doc-actions").getByRole("button", { name: "Löschen" }).click();
    await bestaetigen(page, "Beleg löschen");
    await page.waitForURL(/\/belege$/);
  } finally {
    // Die folgenden Tests rechnen ohne Vorgabe
    await vorgabe("");
  }
});

test("Beleg prüfen: Ein geleertes Kategoriefeld gilt sofort als leer, auch wenn Enter vor dem Verlassen speichert", async ({ browser }) => {
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "kategorieleer.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Funknetz Mobil GmbH") }]);
  await expect(page.getByText("kategorieleer.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /kategorieleer\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  const kategorie = page.getByLabel("Kategorie");
  const speichern = page.getByRole("button", { name: "Speichern", exact: true });
  await waehleKategorie(kategorie, "telefon");
  // Feld leeren und ohne es zu verlassen speichern: das erste Enter schließt die Liste, das zweite schickt das Formular ab
  await kategorie.fill("");
  await kategorie.press("Enter");
  await kategorie.press("Enter");
  await expect(speichern).toBeDisabled();
  await page.reload();
  await page.waitForLoadState("networkidle");
  // Gespeichert ist, was im Feld stand: keine Kategorie, nicht die alte
  await expect(page.getByLabel("Kategorie")).toHaveValue("");
  await page.locator(".doc-actions").getByRole("button", { name: "Löschen" }).click();
  await bestaetigen(page, "Beleg löschen");
  await page.waitForURL(/\/belege$/);
});

test("Beleg prüfen: Nach dem Leeren mit den Pfeilen dieselbe Kategorie markiert, übernimmt Enter sie", async ({ browser }) => {
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "kategoriepfeil.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Funknetz Mobil GmbH") }]);
  await expect(page.getByText("kategoriepfeil.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /kategoriepfeil\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  const kategorie = page.getByLabel("Kategorie");
  await waehleKategorie(kategorie, "telefon");
  await kategorie.fill("");
  // Das leere Feld zeigt alle Kategorien und markiert keine: so lange abwärts, bis Telefon markiert ist
  const telefon = trefferliste(page)
    .getByRole("option")
    .filter({ has: page.getByText(kategorieName("telefon"), { exact: true }) });
  const telefonId = await telefon.getAttribute("id");
  for (let schritt = 0; schritt < 60 && (await kategorie.getAttribute("aria-activedescendant")) !== telefonId; schritt++) {
    await kategorie.press("ArrowDown");
  }
  await expect(kategorie).toHaveAttribute("aria-activedescendant", telefonId!);
  await kategorie.press("Enter");
  await expect(kategorie).toHaveValue(kategorieName("telefon"));
  // Der Beleg gehört nur diesem Test: die folgenden zählen die offenen Belege
  await page.locator(".doc-actions").getByRole("button", { name: "Löschen" }).click();
  await bestaetigen(page, "Beleg löschen");
  await page.waitForURL(/\/belege$/);
});

test("Dauerbeleg: Ein geleertes Kategoriefeld verlangt beim Anlegen per Enter wieder eine Kategorie", async () => {
  await go("/dauerbelege/neu");
  // Alles andere ist ausgefüllt: Nur die Kategorie hält das Anlegen auf
  await page.getByLabel("Bezeichnung").fill("Lagerraum Kategorie leer");
  await page.getByLabel("Lieferant", { exact: true }).fill("Hafen Immobilien GmbH");
  await page.getByLabel("Erster Beleg am").fill(day(30));
  await page
    .locator("input[type=file]")
    .setInputFiles([{ name: "lagervertrag.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% Lagervertrag\n%%EOF\n") }]);
  await page.getByLabel("Netto 1").fill("80,00");
  const vorlageKategorie = page.getByLabel("Kategorie");
  await waehleKategorie(vorlageKategorie, "miete");
  await vorlageKategorie.fill("");
  await vorlageKategorie.press("Enter");
  await vorlageKategorie.press("Enter");
  await expect(vorlageKategorie).toHaveAccessibleDescription("Wähle die Kategorie.");
  await expect(page).toHaveURL(/\/dauerbelege\/neu$/);
});

test("Dauerbeleg: Eingaben direkt nach dem Speichern und nach Pausieren bleiben erhalten (#1793)", async () => {
  await go("/dauerbelege/neu");
  const bezeichnung = page.getByLabel("Bezeichnung");
  await bezeichnung.fill("Lagerraum Sperre");
  await page.getByLabel("Lieferant", { exact: true }).fill("Hafen Immobilien GmbH");
  await waehleKategorie(page.getByLabel("Kategorie"), "miete");
  await page.getByLabel("Erster Beleg am").fill(day(30));
  await page
    .locator("input[type=file]")
    .setInputFiles([{ name: "lagervertrag.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% Lagervertrag\n%%EOF\n") }]);
  await page.getByLabel("Netto 1").fill("80,00");
  await page.getByRole("button", { name: "Dauerbeleg anlegen" }).click();
  await page.waitForURL(/\/dauerbelege\/[0-9a-f-]{36}$/);
  // Das Formular der neuen Seite, nicht mehr das von „neu“
  await expect(page.getByRole("heading", { name: "Lagerraum Sperre", level: 1 })).toBeVisible();

  await bezeichnung.fill("Lagerraum gespeichert");
  await eingabeNachAktion(page, {
    aktion: page.getByRole("button", { name: "Speichern", exact: true }),
    feld: bezeichnung,
    text: "Gleich danach getippt",
    neuGeladen: page.getByRole("heading", { name: "Lagerraum gespeichert", level: 1 }),
  });
  // Pausieren baut das Formular ebenso neu auf. Die Eingabe davor ist ungespeichert, deshalb erst die Rückfrage (#1805)
  await page.getByRole("button", { name: "Pausieren", exact: true }).click();
  await eingabeNachAktion(page, {
    aktion: page.getByRole("dialog").getByRole("button", { name: "Trotzdem pausieren", exact: true }),
    feld: bezeichnung,
    text: "Nach dem Pausieren getippt",
    neuGeladen: page.getByText(/Pausiert: Bis zum Fortsetzen/),
  });
});

test("Dauerbeleg: Kurz nacheinander gespeichert, baut sich das Formular jedes Mal neu auf (#1804)", async () => {
  // Der Dauerbeleg aus dem Test davor
  await kurzNacheinanderSpeichern({
    feld: page.getByLabel("Bezeichnung"),
    speichern: page.getByRole("button", { name: "Speichern", exact: true }),
    texte: ["Lagerraum eins", "Lagerraum zwei", "Lagerraum drei"],
  });
});

test("Dauerbeleg: Speichern schlägt fehl, der Fokus steht danach wieder im Feld (#1793)", async () => {
  // Der Dauerbeleg aus den Tests davor
  await fokusNachFehlschlag(page, page.getByLabel("Bezeichnung"));
  // Der Dauerbeleg gehört nur diesen drei Tests
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Vorlage löschen");
  await expect(page).toHaveURL(/\/dauerbelege(?:\?.*)?$/);
});

test("Dauerbeleg: Pausieren, Fortsetzen und Beenden fragen bei ungespeicherten Änderungen nach (#1805)", async () => {
  await go("/dauerbelege/neu");
  const bezeichnung = page.getByLabel("Bezeichnung");
  await bezeichnung.fill("Lagerraum Rückfrage");
  await page.getByLabel("Lieferant", { exact: true }).fill("Hafen Immobilien GmbH");
  await waehleKategorie(page.getByLabel("Kategorie"), "miete");
  await page.getByLabel("Erster Beleg am").fill(day(30));
  await page
    .locator("input[type=file]")
    .setInputFiles([{ name: "lagervertrag.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% Lagervertrag Rückfrage\n%%EOF\n") }]);
  await page.getByLabel(/^Weist die Umsatzsteuer gesondert aus/).check();
  await page.getByLabel("Netto 1").fill("80,00");
  await page.getByRole("button", { name: "Dauerbeleg anlegen" }).click();
  await page.waitForURL(/\/dauerbelege\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Lagerraum Rückfrage", level: 1 })).toBeVisible();
  const dialog = page.getByRole("dialog");
  const aktiv = page.getByText(/^Aktiv: Haben legt/);
  const pausiert = page.getByText(/^Pausiert: Bis zum Fortsetzen/);
  const brutto = page.getByLabel("Brutto 1", { exact: true });
  const steuer = page.getByLabel("Umsatzsteuer 1", { exact: true });

  // Ohne Änderungen wie bisher: kein Dialog, auch nicht nach Zurücktippen. Danach gilt das Brutto als zuletzt eingegeben
  // und die Steuer als von Hand geändert; gespeichert würde trotzdem dasselbe
  await brutto.fill("95,21");
  await brutto.fill("95,20");
  await page.getByRole("button", { name: "Pausieren", exact: true }).click();
  await expect(pausiert).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await steuer.fill("15,21");
  await steuer.fill("15,20");
  await page.getByRole("button", { name: "Fortsetzen", exact: true }).click();
  await expect(aktiv).toBeVisible();
  await expect(dialog).toHaveCount(0);

  // Mit Änderung: Abbrechen lässt Status und Eingabe stehen
  await bezeichnung.fill("Lagerraum ungespeichert");
  await page.getByRole("button", { name: "Pausieren", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Lagerraum Rückfrage pausieren?" })).toContainText(
    "Das Formular hat ungespeicherte Änderungen. Beim Pausieren gehen sie verloren.",
  );
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(bezeichnung).toHaveValue("Lagerraum ungespeichert");
  await expect(aktiv).toBeVisible();
  // Bestätigt: pausiert, die Änderung ist verworfen
  await page.getByRole("button", { name: "Pausieren", exact: true }).click();
  await bestaetigen(page, "Trotzdem pausieren");
  await expect(pausiert).toBeVisible();
  await expect(bezeichnung).toHaveValue("Lagerraum Rückfrage");

  // Fortsetzen ebenso
  await bezeichnung.fill("Lagerraum ungespeichert");
  await page.getByRole("button", { name: "Fortsetzen", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Lagerraum Rückfrage fortsetzen?" })).toContainText("Beim Fortsetzen gehen sie verloren.");
  await bestaetigen(page, "Trotzdem fortsetzen");
  await expect(aktiv).toBeVisible();
  await expect(bezeichnung).toHaveValue("Lagerraum Rückfrage");

  // Beenden fragt ohnehin nach; mit Änderung nennt dieselbe Rückfrage den Verlust
  const beenden = page.getByRole("dialog", { name: "Lagerraum Rückfrage beenden?" });
  await page.getByRole("button", { name: "Beenden", exact: true }).click();
  await expect(beenden).toContainText("Beenden ist endgültig");
  await expect(beenden).not.toContainText("ungespeicherte Änderungen");
  await beenden.getByRole("button", { name: "Abbrechen" }).click();
  await bezeichnung.fill("Lagerraum ungespeichert");
  await page.getByRole("button", { name: "Beenden", exact: true }).click();
  await expect(beenden).toContainText("Das Formular hat ungespeicherte Änderungen. Beim Beenden gehen sie verloren.");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await bestaetigen(page, "Beenden");
  await expect(page.getByText(/^Beendet: Es entstehen keine Belege mehr/)).toBeVisible();

  // Löschen fragt ohne Formular wie bisher; der Dauerbeleg gehört nur diesem Test
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Vorlage löschen");
  await expect(page).toHaveURL(/\/dauerbelege(?:\?.*)?$/);
});

test("Dauerbeleg: Wechsel ohne Neuladen zu einem mit gleichem Zeitstempel zeigt dessen Angaben, die Meldung des vorigen geht (#1839)", async () => {
  const sql = postgres(databaseUrlFuer(DURCHLAUF), { max: 1 });
  const termin = day(30);
  const betrag = (net: number) => JSON.stringify([{ taxRate: 1900, net, tax: Math.round(net * 0.19) }]);
  const bezeichnung = page.getByLabel("Bezeichnung");
  const lieferant = page.getByLabel("Lieferant", { exact: true });
  const gespeichert = page.getByRole("status").filter({ hasText: "Gespeichert." });
  try {
    // Zwei pausierte Vorlagen ohne Datei in einer Anweisung, also mit demselben updated_at
    await sql.begin(async (tx) => {
      await tx`select set_config('haben.actor', 'e2e', true)`;
      await tx`insert into recurring_documents (name, status, supplier_name, category, amounts, recurrence, anchor_day, start_date, next_date)
        values ('Stellplatz Wechsel Nord', 'pausiert', 'Parkhaus Nord GmbH', 'miete', ${betrag(5000)}::jsonb, 'P1M', ${Number(termin.slice(8))}, ${termin}, ${termin}),
          ('Stellplatz Wechsel Süd', 'pausiert', 'Parkhaus Süd GmbH', 'miete', ${betrag(7000)}::jsonb, 'P1M', ${Number(termin.slice(8))}, ${termin}, ${termin})`;
    });
    await go("/dauerbelege");
    await ueberSchnellsuche(page, "Stellplatz Wechsel Nord", /Stellplatz Wechsel Nord/);
    await expect(page.getByRole("heading", { level: 1, name: "Stellplatz Wechsel Nord" })).toBeVisible();
    await expect(lieferant).toHaveValue("Parkhaus Nord GmbH");
    await ueberSchnellsuche(page, "Stellplatz Wechsel Süd", /Stellplatz Wechsel Süd/);
    await expect(page.getByRole("heading", { level: 1, name: "Stellplatz Wechsel Süd" })).toBeVisible();
    await expect(bezeichnung).toHaveValue("Stellplatz Wechsel Süd");
    await expect(lieferant).toHaveValue("Parkhaus Süd GmbH");
    await expect(page.getByLabel("Netto 1")).toHaveValue("70,00");

    // Gespeichert, dann zurück: Die Meldung gehört zur anderen Vorlage
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(gespeichert).toBeVisible();
    await ueberSchnellsuche(page, "Stellplatz Wechsel Nord", /Stellplatz Wechsel Nord/);
    await expect(bezeichnung).toHaveValue("Stellplatz Wechsel Nord");
    await expect(gespeichert).toHaveCount(0);
  } finally {
    await sql.begin(async (tx) => {
      await tx`select set_config('haben.actor', 'e2e', true)`;
      await tx`delete from recurring_documents where name like 'Stellplatz Wechsel %'`;
    });
    await sql.end();
  }
});

test("Beleg mit § 13b: Steuer selbst berechnet, gezahlt wird netto", async ({ browser }) => {
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "cloud.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Cloud EMEA Ltd") }]);
  await expect(page.getByText("cloud.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /cloud\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  // USt-IdNr. liegt in „Weitere Angaben“, die Überschrift zeigt sie auch zugeklappt
  await weitereAngabenOeffnen(page);
  await page.getByLabel(/^USt-IdNr\. des Lieferanten/).fill("IE6388047V");
  await expect(page.locator("details.weitere-angaben > summary")).toContainText("USt-IdNr. IE6388047V");
  await page.getByLabel("Netto", { exact: true }).fill("100");
  await expect(page.getByLabel("Vorsteuer", { exact: true })).toBeEditable();
  await page.getByLabel("Vorsteuer", { exact: true }).fill("0");
  await expect(page.getByText(/meist Reverse Charge \(§ 13b\)/)).toBeVisible();
  await page.getByRole("combobox", { name: /^Wer schuldet die Umsatzsteuer/ }).selectOption("eu");
  await expect(page.getByLabel("Steuer § 13b")).toHaveValue("19,00");
  await expect(page.getByLabel("Steuer § 13b")).not.toBeEditable();
  await expect(page.getByLabel("Steuer § 13b")).toHaveAttribute("readonly", "");
  await expect(page.getByText("Steuer § 13b (automatisch)", { exact: true })).toBeVisible();
  // Die Kennzahlen stehen unter „Details“, der Hinweis am Feld nennt sie nicht
  await expect(page.getByText(/Kz 46/)).toBeHidden();
  await page.getByText("Details zur Voranmeldung", { exact: true }).click();
  await expect(page.getByText(/Netto in Kz 46, Steuer in Kz 47, Vorsteuer in Kz 67/)).toBeVisible();
  await expect(page.getByText("Zu zahlen (netto)")).toBeVisible();
  await page.getByLabel("Netto", { exact: true }).fill("200");
  await expect(page.getByLabel("Steuer § 13b")).toHaveValue("38,00");
  await page.getByRole("combobox", { name: /^Satz/ }).selectOption("700");
  await expect(page.getByLabel("Steuer § 13b")).toHaveValue("14,00");
  await page.getByRole("combobox", { name: /^Wer schuldet die Umsatzsteuer/ }).selectOption("drittland");
  await expect(page.getByLabel("Steuer § 13b")).not.toBeEditable();
  const gespeichert = page.waitForResponse((r) => r.url().includes("/_serverFn/") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  expect((await gespeichert).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Speichern", exact: true })).toBeDisabled();
  // Altbestand: Die bisherige Maske erlaubte, selbst geschuldete Steuer manuell auf 0 zu setzen.
  const sql = postgres(databaseUrlFuer(DURCHLAUF), { max: 1 });
  try {
    await sql`update document_amounts set tax = 0 where document_id = ${page.url().split("/").pop()!}`;
  } finally {
    await sql.end();
  }
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByLabel("Steuer § 13b")).toHaveValue("14,00");
  // Die Korrektur ist ungespeichert, damit auch „Bestätigen und buchen“ sie zuerst persistiert.
  await expect(page.getByRole("button", { name: "Speichern", exact: true })).toBeEnabled();
  const korrigiert = page.waitForResponse((r) => r.url().includes("/_serverFn/") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  expect((await korrigiert).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Speichern", exact: true })).toBeDisabled();
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByLabel("Steuer § 13b")).toHaveValue("14,00");
  // Auch gespeicherte Zeilen müssen bei einer Änderung weiter automatisch rechnen.
  await page.getByLabel("Netto", { exact: true }).fill("300");
  await expect(page.getByLabel("Steuer § 13b")).toHaveValue("21,00");
  await page.getByRole("combobox", { name: /^Wer schuldet die Umsatzsteuer/ }).selectOption("");
  await expect(page.getByLabel("Vorsteuer", { exact: true })).toBeEditable();
  await page.getByLabel("Vorsteuer", { exact: true }).fill("20,99");
  await page.getByLabel("Netto", { exact: true }).fill("400");
  await expect(page.getByLabel("Vorsteuer", { exact: true })).toHaveValue("20,99");
  // Nicht buchen: der Beleg würde die folgenden Auswertungen verändern
  await page.getByRole("button", { name: "Löschen" }).click();
  // Esc bricht nur die Rückfrage ab und bleibt beim Beleg
  const url = page.url();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Löschen", exact: true })).toBeVisible();
  expect(page.url()).toBe(url);
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Beleg löschen");
  await page.waitForURL(/\/belege$/);
});

test("Beleg mit Bruttobetrag: Netto und Vorsteuer vorgerechnet, Satzwechsel behält das Brutto (#917)", async ({ browser }) => {
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "tankstelle.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Tankstelle Nord") }]);
  await expect(page.getByText("tankstelle.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /tankstelle\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  const amounts = page.getByRole("group", { name: "Beträge je Steuersatz" });
  await amounts.getByLabel("Brutto", { exact: true }).fill("119,00");
  await expect(amounts.getByLabel("Netto", { exact: true })).toHaveValue("100,00");
  await expect(amounts.getByLabel("Vorsteuer", { exact: true })).toHaveValue("19,00");
  // Anderer Satz: das Brutto bleibt, Netto und Vorsteuer ändern sich
  await amounts.getByRole("combobox", { name: /^Satz/ }).selectOption("700");
  await expect(amounts.getByLabel("Netto", { exact: true })).toHaveValue("111,21");
  await expect(amounts.getByLabel("Vorsteuer", { exact: true })).toHaveValue("7,79");
  await expect(amounts.getByLabel("Brutto", { exact: true })).toHaveValue("119,00");
  // Vorsteuer laut Rechnung von Hand: das Brutto folgt
  await amounts.getByLabel("Vorsteuer", { exact: true }).fill("7,78");
  await expect(amounts.getByLabel("Brutto", { exact: true })).toHaveValue("118,99");
  // Bei § 13b gibt es kein Brutto, gezahlt wird netto; die Steuer rechnet Haben aus dem Netto (111,21 € zu 7 % = 7,78 €)
  await page.getByRole("combobox", { name: /^Wer schuldet die Umsatzsteuer/ }).selectOption("eu");
  await expect(amounts.getByLabel("Brutto", { exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: /^Wer schuldet die Umsatzsteuer/ }).selectOption("");
  await expect(amounts.getByLabel("Brutto", { exact: true })).toHaveValue("118,99");
  // Nicht buchen: die folgenden Tests zählen die Belege und Auswertungen
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Beleg löschen");
  await page.waitForURL(/\/belege$/);
});

test("Beleg gespeichert und neu geöffnet: Vorsteuer folgt Netto und Satz, ein Brutto bleibt (#1099)", async ({ browser }) => {
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "buerobedarf.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Bürobedarf Süd") }]);
  await expect(page.getByText("buerobedarf.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /buerobedarf\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  const amounts = page.getByRole("group", { name: "Beträge je Steuersatz" });
  const speichernUndNeuLaden = async () => {
    const gespeichert = page.waitForResponse((r) => r.url().includes("/_serverFn/") && r.request().method() === "POST");
    await page.locator(".doc-actions").getByRole("button", { name: "Speichern" }).click();
    const antwort = await gespeichert;
    expect(antwort.ok()).toBe(true);
    expect(await antwort.finished()).toBeNull();
    await page.reload();
    await page.waitForLoadState("networkidle");
  };
  // Aus dem Netto gespeichert: nach dem Öffnen folgt die Vorsteuer einem neuen Netto und einem anderen Satz
  await amounts.getByLabel("Netto", { exact: true }).fill("100,00");
  await expect(amounts.getByLabel("Vorsteuer", { exact: true })).toHaveValue("19,00");
  await speichernUndNeuLaden();
  await amounts.getByLabel("Netto", { exact: true }).fill("200,00");
  await expect(amounts.getByLabel("Vorsteuer", { exact: true })).toHaveValue("38,00");
  await amounts.getByRole("combobox", { name: /^Satz/ }).selectOption("700");
  await expect(amounts.getByLabel("Vorsteuer", { exact: true })).toHaveValue("14,00");
  // Aus dem Brutto gespeichert: ein anderer Satz behält das Brutto wie direkt nach der Eingabe
  await amounts.getByRole("combobox", { name: /^Satz/ }).selectOption("1900");
  await amounts.getByLabel("Brutto", { exact: true }).fill("45,00");
  await expect(amounts.getByLabel("Vorsteuer", { exact: true })).toHaveValue("7,18");
  await speichernUndNeuLaden();
  await amounts.getByRole("combobox", { name: /^Satz/ }).selectOption("700");
  await expect(amounts.getByLabel("Netto", { exact: true })).toHaveValue("42,06");
  await expect(amounts.getByLabel("Vorsteuer", { exact: true })).toHaveValue("2,94");
  await expect(amounts.getByLabel("Brutto", { exact: true })).toHaveValue("45,00");
  // Vorsteuer laut Rechnung von Hand: bleibt nach dem Öffnen stehen
  await amounts.getByRole("combobox", { name: /^Satz/ }).selectOption("1900");
  await amounts.getByLabel("Netto", { exact: true }).fill("100,00");
  await amounts.getByLabel("Vorsteuer", { exact: true }).fill("18,99");
  await speichernUndNeuLaden();
  await amounts.getByLabel("Netto", { exact: true }).fill("200,00");
  await expect(amounts.getByLabel("Vorsteuer", { exact: true })).toHaveValue("18,99");
  // Nicht buchen: die folgenden Tests zählen die Belege und Auswertungen
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Beleg löschen");
  await page.waitForURL(/\/belege$/);
});

test("Beleg am Laptop: Netto, Vorsteuer und Brutto sind neben der Vorschau ganz zu lesen (#917)", async ({ browser }) => {
  // 1280 px: Formular und Vorschau stehen ab 1201 px nebeneinander, die Zeile hat mit Brutto drei Betragsfelder
  const context = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 1280, height: 800 } });
  const laptop = await context.newPage();
  await laptop.goto("/belege");
  await laptop.waitForLoadState("networkidle");
  await laptop
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "laptop-betraege.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Bürohaus Nord GmbH") }]);
  await expect(laptop.getByText("laptop-betraege.jpg: abgelegt.")).toBeVisible();
  await laptop
    .getByRole("link", { name: /laptop-betraege\.jpg/ })
    .first()
    .click();
  await laptop.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await laptop.waitForLoadState("networkidle");
  const amounts = laptop.getByRole("group", { name: "Beträge je Steuersatz" });
  await amounts.getByLabel("Brutto", { exact: true }).fill("14.691,26");
  await expect(amounts.getByLabel("Netto", { exact: true })).toHaveValue("12.345,60");
  const abgeschnitten = () =>
    laptop
      .locator(".amount-row input[inputmode='decimal']")
      .evaluateAll((felder) =>
        (felder as HTMLInputElement[]).filter((f) => f.scrollWidth > f.clientWidth + 1).map((f) => `${f.value}: ${f.scrollWidth} > ${f.clientWidth}`),
      );
  const oben = async (label: string) => (await amounts.getByLabel(label, { exact: true }).boundingBox())!.y;
  expect(await abgeschnitten(), "Netto, Vorsteuer und Brutto").toEqual([]);
  // Ausgeklappt ist die Formularspalte zu schmal für drei Betragsfelder: Brutto steht unter Netto
  expect(await oben("Brutto")).toBeGreaterThan(await oben("Netto"));
  // Eingeklappt zählt die breitere Arbeitsfläche, nicht das Fenster: alle drei in einer Zeile, keins abgeschnitten
  await laptop.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("button", { name: "Seitenleiste einklappen" }).click();
  await expect.poll(async () => (await oben("Brutto")) - (await oben("Netto"))).toBe(0);
  expect(await oben("Vorsteuer")).toBe(await oben("Netto"));
  expect(await abgeschnitten(), "Netto, Vorsteuer und Brutto eingeklappt").toEqual([]);
  // 1120 px: ausgeklappt untereinander, eingeklappt Beleg und Formular nebeneinander
  await laptop.setViewportSize({ width: 1120, height: 800 });
  const beleg = laptop.locator(".doc-editor > .doc-image");
  const formular = laptop.locator(".doc-editor > .stack");
  await expect.poll(async () => (await formular.boundingBox())!.x).toBeGreaterThan((await beleg.boundingBox())!.x + 400);
  await laptop.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("button", { name: "Seitenleiste ausklappen" }).click();
  await expect.poll(async () => (await formular.boundingBox())!.y).toBeGreaterThan((await beleg.boundingBox())!.y + 400);
  // Untereinander bleibt der Beleg nicht stehen, sonst deckt er beim Scrollen das Formular zu und fängt den Klick ab
  await amounts.getByLabel("Brutto", { exact: true }).click({ timeout: 5_000 });
  await laptop.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(laptop, "Beleg löschen");
  await laptop.waitForURL(/\/belege$/);
  await context.close();
});

/**
 * Klassische Scrollleiste (Windows, Linux, macOS mit „Rollbalken immer anzeigen“, #1152): Playwright blendet Scrollleisten
 * sonst aus. Ein eigener Browser, weil sich das je Test nicht umstellen lässt (wie in vorschau.spec.ts); mit den
 * launchOptions der Konfiguration, damit PLAYWRIGHT_CHROMIUM_EXECUTABLE auch hier gilt.
 */
async function mitScrollleiste(baseURL: string | undefined, viewport: { width: number; height: number }) {
  const browser = await chromium.launch({ ...test.info().project.use.launchOptions, ignoreDefaultArgs: ["--hide-scrollbars"] });
  const context = await browser.newContext({ baseURL, viewport, storageState: await page.context().storageState() });
  const seite = await context.newPage();
  return {
    seite,
    breite: (width: number, height = viewport.height) => seite.setViewportSize({ width, height }),
    /** Spalten von .editor-grid: 1 untereinander, 2 nebeneinander */
    spalten: () => seite.locator(".editor-grid").evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length),
    scrollleiste: () => seite.evaluate(() => window.innerWidth - document.documentElement.clientWidth),
    einklappen: async (zu: "einklappen" | "ausklappen") => {
      await seite
        .getByRole("navigation", { name: "Hauptnavigation" })
        .getByRole("button", { name: `Seitenleiste ${zu}` })
        .click();
      if (zu === "einklappen") await expect(seite.locator("html")).toHaveAttribute("data-nav", "collapsed");
      else await expect(seite.locator("html")).not.toHaveAttribute("data-nav", "collapsed");
    },
    schliessen: () => browser.close(),
  };
}

test("Klassische Scrollleiste: Dauerbeleg steht ab 1201 px neben dem Vertrag, eingeklappt ab 1033 px, auch wenn die Seite scrollt (#1152)", async ({
  baseURL,
}) => {
  await go("/dauerbelege/neu");
  await page.getByLabel("Bezeichnung").fill("Lagerraum Scrollleiste");
  await page.getByLabel("Lieferant", { exact: true }).fill("Hafen Immobilien GmbH");
  await page.getByLabel("Erster Beleg am").fill(day(30));
  await page
    .locator("input[type=file]")
    .setInputFiles([{ name: "lagervertrag.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% Lagervertrag\n%%EOF\n") }]);
  await page.getByLabel("Netto 1").fill("80,00");
  await waehleKategorie(page.getByLabel("Kategorie"), "miete");
  await page.getByRole("button", { name: "Dauerbeleg anlegen" }).click();
  await page.waitForURL(/\/dauerbelege\/[0-9a-f-]{36}$/);

  const { seite, breite, spalten, scrollleiste, einklappen, schliessen } = await mitScrollleiste(baseURL, { width: 1200, height: 800 });
  await seite.goto(new URL(page.url()).pathname);
  await seite.waitForLoadState("networkidle");
  // Die Seite scrollt in beiden Anordnungen; die Scrollleiste nimmt ihr Platz weg, die Grenze bleibt dieselbe wie ohne sie
  expect(await spalten()).toBe(1);
  expect(await scrollleiste()).toBeGreaterThan(0);
  await breite(1201);
  await expect.poll(spalten).toBe(2);
  expect(await scrollleiste()).toBeGreaterThan(0);
  await einklappen("einklappen");
  await breite(1032);
  await expect.poll(spalten).toBe(1);
  await breite(1033);
  await expect.poll(spalten).toBe(2);
  expect(await scrollleiste()).toBeGreaterThan(0);
  await einklappen("ausklappen");
  await expect.poll(spalten).toBe(1);
  await schliessen();

  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Vorlage löschen");
  await page.waitForURL(/\/dauerbelege$/);
});

test("Klassische Scrollleiste: Beleg prüfen steht ab 1201 px nebeneinander, eingeklappt ab 1033 px, nichts ragt über die Seite (#1152)", async ({
  browser,
  baseURL,
}) => {
  const { seite, breite, spalten, scrollleiste, einklappen, schliessen } = await mitScrollleiste(baseURL, { width: 1200, height: 800 });
  await seite.goto("/belege");
  await seite.waitForLoadState("networkidle");
  await seite
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "scrollleiste.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Bürohaus Nord GmbH") }]);
  await expect(seite.getByText("scrollleiste.jpg: abgelegt.")).toBeVisible();
  await seite
    .getByRole("link", { name: /scrollleiste\.jpg/ })
    .first()
    .click();
  await seite.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await seite.waitForLoadState("networkidle");
  const main = seite.locator(".main");
  /** Nichts ragt unten aus .main heraus: Sonst scrollen Seitenkopf und Leiste mit der Seite weg */
  const ueberstand = () => main.evaluate((m) => m.scrollHeight - m.clientHeight);

  // Untereinander scrollt die Seite mit Scrollleiste; ab 1201 px stehen beide nebeneinander, so hoch wie das Fenster
  expect(await spalten()).toBe(1);
  expect(await scrollleiste()).toBeGreaterThan(0);
  await breite(1201);
  await expect.poll(spalten).toBe(2);
  expect(await ueberstand()).toBeLessThanOrEqual(0);
  await einklappen("einklappen");
  await breite(1032);
  await expect.poll(spalten).toBe(1);
  await breite(1033);
  await expect.poll(spalten).toBe(2);
  expect(await ueberstand()).toBeLessThanOrEqual(0);

  // Niedriges Fenster: Der Beleg behält seine 520 px, die Seite scrollt ein Stück; .main wächst mit, Kopf und Leiste bleiben stehen
  const niedrig = async (width: number) => {
    await breite(width, 560);
    await expect.poll(spalten).toBe(2);
    expect(await scrollleiste()).toBeGreaterThan(0);
    expect(await ueberstand()).toBeLessThanOrEqual(0);
    await seite.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    expect(await seite.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect(seite.locator(".main > .page-head")).toBeInViewport({ ratio: 1 });
    expect((await seite.getByRole("navigation", { name: "Hauptnavigation" }).boundingBox())!.y).toBeGreaterThanOrEqual(0);
    await seite.evaluate(() => window.scrollTo(0, 0));
  };
  await niedrig(1040);
  await einklappen("ausklappen");
  await niedrig(1210);

  await seite.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(seite, "Beleg löschen");
  await seite.waitForURL(/\/belege$/);
  await schliessen();
});

test("Dauerbeleg mit Bruttobetrag: Netto und Umsatzsteuer vorgerechnet, ohne ausgewiesene Steuer kein Brutto (#1059, #1100)", async () => {
  await go("/dauerbelege/neu");
  // Ohne ausgewiesene Steuer ist der Betrag zugleich das Brutto; ein eigenes Feld gibt es dann nicht
  await expect(page.getByLabel("Brutto 1", { exact: true })).toHaveCount(0);
  // Ein neuer Dauerbeleg beginnt mit 0 %; der Haken setzt den Satz auf 19 % (#1100)
  await expect(page.getByLabel("Steuersatz 1", { exact: true })).toHaveValue("0");
  await page.getByLabel(/^Weist die Umsatzsteuer gesondert aus/).check();
  await expect(page.getByLabel("Steuersatz 1", { exact: true })).toHaveValue("1900");
  await page.getByLabel("Brutto 1", { exact: true }).fill("119,00");
  await expect(page.getByLabel("Netto 1", { exact: true })).toHaveValue("100,00");
  await expect(page.getByLabel("Umsatzsteuer 1", { exact: true })).toHaveValue("19,00");
  await expect(page.locator(".dauerbeleg-summe")).toContainText(/= 119,00\s€/);
  // Anderer Satz: das Brutto bleibt, Netto und Steuer ändern sich
  await page.getByLabel("Steuersatz 1", { exact: true }).selectOption("700");
  await expect(page.getByLabel("Netto 1", { exact: true })).toHaveValue("111,21");
  await expect(page.getByLabel("Umsatzsteuer 1", { exact: true })).toHaveValue("7,79");
  await expect(page.getByLabel("Brutto 1", { exact: true })).toHaveValue("119,00");
  // Steuer laut Vertrag von Hand: das Brutto folgt
  await page.getByLabel("Umsatzsteuer 1", { exact: true }).fill("7,78");
  await expect(page.getByLabel("Brutto 1", { exact: true })).toHaveValue("118,99");
  // Ein vertipptes Brutto sperrt das Anlegen wie ein vertipptes Netto
  await page.getByLabel("Brutto 1", { exact: true }).fill("119,005");
  await page.getByRole("button", { name: "Dauerbeleg anlegen" }).click();
  await expect(page.getByLabel("Brutto 1", { exact: true })).toHaveAccessibleDescription("Trag den Betrag ein, etwa 850,00.");
  await expect(page).toHaveURL(/\/dauerbelege\/neu$/);
  // Haken aus nach einem Brutto: Grundlage ist wieder das Netto; ein anderer Satz rechnet es nicht aus dem verborgenen Brutto neu
  await page.getByLabel("Brutto 1", { exact: true }).fill("119,00");
  await page.getByLabel("Weist keine Umsatzsteuer aus").check();
  await page.getByLabel("Steuersatz 1", { exact: true }).selectOption("1900");
  await expect(page.getByLabel("Netto 1", { exact: true })).toHaveValue("111,21");
  // Haken wieder an: die nicht von Hand geänderte Steuer folgt dem Netto
  await page.getByLabel(/^Weist die Umsatzsteuer gesondert aus/).check();
  await expect(page.getByLabel("Umsatzsteuer 1", { exact: true })).toHaveValue("21,13");
  // Haken aus und wieder an ändert ein eingegebenes Brutto nicht: 45,00 € zu 19 % sind 37,82 € + 7,18 € (aus dem Netto wären es 7,19 €)
  await page.getByLabel("Brutto 1", { exact: true }).fill("45,00");
  await expect(page.getByLabel("Umsatzsteuer 1", { exact: true })).toHaveValue("7,18");
  await page.getByLabel("Weist keine Umsatzsteuer aus").check();
  await page.getByLabel(/^Weist die Umsatzsteuer gesondert aus/).check();
  await expect(page.getByLabel("Umsatzsteuer 1", { exact: true })).toHaveValue("7,18");
  await expect(page.getByLabel("Brutto 1", { exact: true })).toHaveValue("45,00");
  // Ohne Haken 100,00 € zu 0 %, dann Haken: 19 % und die Steuer aus dem Netto (#1100)
  await page.getByLabel("Weist keine Umsatzsteuer aus").check();
  await page.getByLabel("Steuersatz 1", { exact: true }).selectOption("0");
  await page.getByLabel("Netto 1", { exact: true }).fill("100,00");
  await page.getByLabel(/^Weist die Umsatzsteuer gesondert aus/).check();
  await expect(page.getByLabel("Steuersatz 1", { exact: true })).toHaveValue("1900");
  await expect(page.getByLabel("Umsatzsteuer 1", { exact: true })).toHaveValue("19,00");
  await expect(page.getByLabel("Brutto 1", { exact: true })).toHaveValue("119,00");
  // 0 % bleibt mit Haken wählbar; Haken aus ändert den Satz nicht
  await page.getByLabel("Steuersatz 1", { exact: true }).selectOption("0");
  await expect(page.getByLabel("Umsatzsteuer 1", { exact: true })).toHaveValue("0,00");
  await page.getByLabel("Weist keine Umsatzsteuer aus").check();
  await expect(page.getByLabel("Steuersatz 1", { exact: true })).toHaveValue("0");
});

test("Dauerbeleg als Kleinbetragsrechnung: nur Endbetrag je Satz, höchstens 250 € je Termin, ein anderer Satz behält ihn (#1101)", async () => {
  await go("/dauerbelege/neu");
  await page.getByLabel("Bezeichnung").fill("Fachzeitschrift Abo");
  await page.getByLabel("Lieferant", { exact: true }).fill("Fachverlag GmbH");
  await waehleKategorie(page.getByLabel("Kategorie"), "software");
  await page.getByLabel("Erster Beleg am").fill(day(30));
  await page
    .locator("input[type=file]")
    .setInputFiles([{ name: "abo.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% Fachzeitschrift Abo\n%%EOF\n") }]);
  // Ohne Steuer eingetippt: Beim Wechsel bleibt der Betrag der Endbetrag; wie beim Steuerausweis springt 0 % auf 19 %
  await page.getByLabel("Netto 1", { exact: true }).fill("11,90");
  await page.getByLabel(/^Nennt nur Endbetrag und Steuersatz/).check();
  const brutto = page.getByLabel("Brutto 1", { exact: true });
  const summe = page.locator(".dauerbeleg-summe");
  await expect(page.getByLabel("Steuersatz 1", { exact: true })).toHaveValue("1900");
  await expect(page.getByLabel("Netto 1", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Umsatzsteuer 1", { exact: true })).toHaveCount(0);
  await expect(brutto).toHaveValue("11,90");
  // Netto und Steuer rechnet Haben aus dem Endbetrag (§ 35 Abs. 1 UStDV)
  await expect(summe).toContainText(/10,00\s€ netto \+ 1,90\s€ Umsatzsteuer = 11,90\s€/);
  // Über 250 € je Termin keine Kleinbetragsrechnung (§ 33 UStDV): die Meldung steht am Endbetrag
  await brutto.fill("250,01");
  await page.getByRole("button", { name: "Dauerbeleg anlegen" }).click();
  await expect(brutto).toHaveAccessibleDescription(/nur bis 250 € brutto je Termin \(§ 33 UStDV\)/);
  await expect(page).toHaveURL(/\/dauerbelege\/neu$/);
  await brutto.fill("11,90");
  await page.getByRole("button", { name: "Dauerbeleg anlegen" }).click();
  await page.waitForURL(/\/dauerbelege\/[0-9a-f-]{36}$/);
  // Gespeichert sind 10,00 € + 1,90 €, das folgt auch aus dem Netto; ein anderer Satz teilt trotzdem den Endbetrag neu auf
  await expect(brutto).toHaveValue("11,90");
  await page.getByLabel("Steuersatz 1", { exact: true }).selectOption("700");
  await expect(brutto).toHaveValue("11,90");
  await expect(summe).toContainText(/11,12\s€ netto \+ 0,78\s€ Umsatzsteuer = 11,90\s€/);
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Vorlage löschen");
  await expect(page).toHaveURL(/\/dauerbelege(?:\?.*)?$/);
});

test("Beleg auf mehrere Kategorien aufteilen: Zeilen hinzufügen und entfernen, Summen gegen den Beleg", async ({ browser }) => {
  // Beispiel aus #271, je 19 %: 100 € Handelsware, 50 € Software, 20 € Bürobedarf = 170 € netto, 32,30 € Vorsteuer
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "buerohaus.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Bürohaus Nord GmbH") }]);
  await expect(page.getByText("buerohaus.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /buerohaus\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Lieferant", { exact: true }).fill("Bürohaus Nord GmbH");
  await page.getByLabel("Belegdatum").fill(day(-5));
  await waehleKategorie(page.getByLabel("Kategorie"), "wareneinkauf");
  const amounts = page.getByRole("group", { name: "Beträge je Steuersatz" });
  await amounts.getByLabel("Netto", { exact: true }).fill("170,00");
  await expect(amounts.getByLabel("Vorsteuer", { exact: true })).toHaveValue("32,30");

  await page.getByRole("button", { name: "Auf mehrere Kategorien aufteilen" }).click();
  const split = page.getByRole("group", { name: "Aufteilung auf Kategorien" });
  // Erste Zeile mit der bisherigen Kategorie und dem ganzen Netto, dazu eine leere
  await expect(split.getByLabel("Kategorie")).toHaveCount(2);
  await expect(split.getByLabel("Kategorie").first()).toHaveValue(kategorieName("wareneinkauf"));
  await split.getByRole("textbox", { name: "Netto", exact: true }).first().fill("100,00");
  await waehleKategorie(split.getByLabel("Kategorie").nth(1), "software");
  await split.getByRole("textbox", { name: "Netto", exact: true }).nth(1).fill("50,00");
  await expect(split.getByText("19 %: Zeilen 150,00 € von 170,00 € netto · noch 20,00 € zu verteilen")).toBeVisible();
  // Ohne Kategorie speichert „Speichern“ nicht, sondern sagt an der Zeile, was fehlt (DESIGN.md, Gesperrte Knöpfe)
  await split.getByRole("button", { name: "+ Zeile" }).click();
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(split.getByLabel("Kategorie").nth(2)).toBeFocused();
  await expect(split.getByLabel("Kategorie").nth(2)).toHaveAccessibleDescription("Wähle die Kategorie.");
  await waehleKategorie(split.getByLabel("Kategorie").nth(2), "buero");
  await split.getByRole("textbox", { name: "Netto", exact: true }).nth(2).fill("20,00");
  await expect(split.getByText("19 %: Zeilen 170,00 € von 170,00 € netto · stimmt")).toBeVisible();
  // Vorsteuer anteilig: 19,00 + 9,50 + 3,80 = 32,30
  await expect(split.getByText("Vorsteuer 19,00")).toBeVisible();
  await expect(split.getByText("Vorsteuer 9,50")).toBeVisible();
  await expect(split.getByText("Vorsteuer 3,80")).toBeVisible();

  // Eine vierte Zeile mit gleicher Kategorie und gleichem Satz, wieder entfernt
  await split.getByRole("button", { name: "+ Zeile" }).click();
  await waehleKategorie(split.getByLabel("Kategorie").nth(3), "software");
  await split.getByRole("textbox", { name: "Netto", exact: true }).nth(3).fill("5,00");
  await expect(split.getByText("19 %: Zeilen 175,00 € von 170,00 € netto · 5,00 € zu viel")).toBeVisible();
  await split.getByRole("button", { name: "Zeile 4 der Aufteilung entfernen" }).click();
  await expect(split.getByLabel("Kategorie")).toHaveCount(3);

  // Gespeichert und neu geladen: die Zeilen bleiben, nichts fehlt mehr vor dem Buchen
  // Erst neu laden, wenn der Server das Speichern beantwortet hat: „Speichern“ ist schon während der Anfrage gesperrt
  const gespeichert = page.waitForResponse((r) => r.url().includes("/_serverFn/") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Speichern" }).click();
  expect((await gespeichert).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Speichern" })).toBeDisabled();
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("aufgeteilt auf 3 Zeilen")).toBeVisible();
  await expect(split.getByRole("textbox", { name: "Netto", exact: true })).toHaveCount(3);
  await expect(split.getByRole("textbox", { name: "Netto", exact: true }).nth(2)).toHaveValue("20,00");
  await expect(page.getByText(/Vor dem Buchen/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Bestätigen und buchen" })).toBeEnabled();

  // Barrierefrei auch mit Aufteilung, am Desktop und am Handy
  const context = await browser.newContext({ storageState: await page.context().storageState() });
  const axePage = await context.newPage();
  for (const width of [1440, 390]) {
    await axePage.setViewportSize({ width, height: 900 });
    await axePage.goto(page.url());
    await axePage.waitForLoadState("networkidle");
    await expect(axePage.getByRole("group", { name: "Aufteilung auf Kategorien" })).toBeVisible();
    const { violations } = await new AxeBuilder({ page: axePage })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
      .analyze();
    expect(
      violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
      `Beleg mit Aufteilung bei ${width} px`,
    ).toEqual([]);
  }
  await context.close();

  // Aufheben: wieder eine Kategorie, die der ersten Zeile
  await split.getByRole("button", { name: "Aufteilung aufheben" }).click();
  await expect(split).toHaveCount(0);
  await expect(page.getByLabel("Kategorie")).toHaveValue(kategorieName("wareneinkauf"));
  // Nicht buchen: der Beleg würde die folgenden Auswertungen verändern; Buchung, EÜR, UStVA und DATEV prüfen die
  // Integrationstests in server/modules/belege/splits.test.ts
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Beleg löschen");
  await page.waitForURL(/\/belege$/);
});

test("Beleg mit § 13b aufteilen: Steuer § 13b je Zeile, innergemeinschaftlicher Erwerb bleibt gesperrt", async ({ browser }) => {
  // Erfundene Sammelrechnung (#508): 200 € Gebühren und 50 € Werbung zu 19 % nach § 13b, 47,50 € Steuer
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "gebuehren.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Beispiel Payments Ltd.") }]);
  await expect(page.getByText("gebuehren.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /gebuehren\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Lieferant", { exact: true }).fill("Beispiel Payments Ltd.");
  await page.getByLabel("Belegdatum").fill(day(-5));
  await waehleKategorie(page.getByLabel("Kategorie"), "geldverkehr");
  await page.getByLabel("Netto", { exact: true }).fill("250,00");

  await page.getByRole("combobox", { name: /^Wer schuldet die Umsatzsteuer/ }).selectOption("ig_erwerb");
  await expect(page.getByRole("button", { name: "Auf mehrere Kategorien aufteilen" })).toBeDisabled();
  await expect(page.getByText("mit innergemeinschaftlichem Erwerb noch nicht möglich")).toBeVisible();

  await page.getByRole("combobox", { name: /^Wer schuldet die Umsatzsteuer/ }).selectOption("eu");
  await expect(page.getByLabel("Steuer § 13b")).toHaveValue("47,50");
  await page.getByRole("button", { name: "Auf mehrere Kategorien aufteilen" }).click();
  const split = page.getByRole("group", { name: "Aufteilung auf Kategorien" });
  await expect(split.getByLabel("Kategorie").first()).toHaveValue(kategorieName("geldverkehr"));
  await split.getByRole("textbox", { name: "Netto", exact: true }).first().fill("200,00");
  await waehleKategorie(split.getByLabel("Kategorie").nth(1), "werbung");
  await split.getByRole("textbox", { name: "Netto", exact: true }).nth(1).fill("50,00");
  await expect(split.getByText("19 %: Zeilen 250,00 € von 250,00 € netto · stimmt")).toBeVisible();
  await expect(split.getByText("Steuer § 13b 38,00")).toBeVisible();
  await expect(split.getByText("Steuer § 13b 9,50")).toBeVisible();

  const gespeichert = page.waitForResponse((r) => r.url().includes("/_serverFn/") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Speichern" }).click();
  expect((await gespeichert).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Speichern" })).toBeDisabled();
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("aufgeteilt auf 2 Zeilen")).toBeVisible();
  await expect(page.getByText(/Vor dem Buchen/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Bestätigen und buchen" })).toBeEnabled();
  // Nicht buchen: Buchung, Voranmeldung, EÜR und DATEV prüfen die Integrationstests in server/modules/belege/splits-13b.test.ts
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Beleg löschen");
  await page.waitForURL(/\/belege$/);
});

test("Beleg am Handy: Beträge sind auch mit 16 px Schrift ganz zu lesen", async ({ browser }) => {
  const context = await browser.newContext({
    storageState: await page.context().storageState(),
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const handy = await context.newPage();
  await handy.goto("/belege");
  await handy.waitForLoadState("networkidle");
  await handy
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "handy-betraege.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Bürohaus Nord GmbH") }]);
  await expect(handy.getByText("handy-betraege.jpg: abgelegt.")).toBeVisible();
  await handy
    .getByRole("link", { name: /handy-betraege\.jpg/ })
    .first()
    .click();
  await handy.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await handy.waitForLoadState("networkidle");

  /** Felder, deren Inhalt breiter ist als das Feld: Beim Betrag wären die letzten Ziffern nicht zu sehen */
  const abgeschnitten = (selektor: string) =>
    handy
      .locator(selektor)
      .evaluateAll((felder) =>
        (felder as HTMLInputElement[]).filter((f) => f.scrollWidth > f.clientWidth + 1).map((f) => `${f.value}: ${f.scrollWidth} > ${f.clientWidth}`),
      );

  await waehleKategorie(handy.getByLabel("Kategorie"), "wareneinkauf");
  await handy.locator(".amount-row").getByLabel("Netto", { exact: true }).fill("500,00");
  await handy.locator(".amount-row").getByLabel("Vorsteuer", { exact: true }).fill("95,00");
  expect.soft(await abgeschnitten(".amount-row input[inputmode='decimal']"), "Netto und Vorsteuer des Belegs").toEqual([]);

  await handy.getByRole("button", { name: "Auf mehrere Kategorien aufteilen" }).click();
  const netto = handy.locator(".document-split-row input[inputmode='decimal']");
  await expect(netto.first()).toBeVisible();
  await netto.first().fill("1.234,56");
  expect.soft(await abgeschnitten(".document-split-row input[inputmode='decimal']"), "Netto in der Aufteilung").toEqual([]);

  // Nicht buchen: Die folgenden Tests zählen die Belege und Auswertungen
  await handy.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(handy, "Beleg löschen");
  await handy.waitForURL(/\/belege$/);
  await context.close();
});

test("Lieferant im Kontaktverzeichnis und im Beleg auswählen", async ({ browser }) => {
  await go("/kontakte/neu");
  await page.getByLabel("Name oder Firma").fill("Hetzner Online GmbH");
  await page.getByLabel("Kunde", { exact: true }).uncheck();
  await page.getByLabel("Lieferant", { exact: true }).check();
  await page.getByLabel("USt-IdNr.").fill("DE812871812");
  await page.getByRole("button", { name: "Kontakt anlegen" }).click();
  await expect(page.getByRole("heading", { name: "Versionen" })).toBeVisible();

  // Filter in der Liste: Lieferanten zeigt ihn, Kunden nicht; im Rechnungseditor steht er nicht zur Auswahl
  await go("/kontakte?rolle=lieferant");
  await expect(page.getByRole("region", { name: "Kontaktliste" })).toContainText("Hetzner Online GmbH");
  await go("/kontakte?rolle=kunde");
  await expect(page.getByRole("region", { name: "Kontaktliste" })).not.toContainText("Hetzner Online GmbH");
  await go("/rechnungen/neu");
  // Nur Kunden in der Suche: Für den Lieferanten bleibt allein das Anlegen
  await page.getByRole("combobox", { name: "Kunde", exact: true }).fill("Hetzner");
  await expect(trefferliste(page).getByRole("option")).toHaveText("„Hetzner“ als neuen Kunden anlegen");

  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "hetzner.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Hetzner Online GmbH") }]);
  await expect(page.getByText("hetzner.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /hetzner\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  await lieferantWaehlen(page, "Hetzner Online GmbH · DE812871812");
  // Ein Feld für Name und Kontakt (#1253): keine zweite Suche „Aus den Kontakten“, die gewählte Verknüpfung steht als Hinweis am Feld
  await expect(page.getByLabel("Lieferant", { exact: true })).toHaveValue("Hetzner Online GmbH");
  await expect(page.getByRole("combobox", { name: /Lieferant|Kontakten/ })).toHaveCount(1);
  await expect(page.getByLabel("Aus den Kontakten")).toHaveCount(0);
  await expect(page.getByLabel("Lieferant", { exact: true })).toHaveAccessibleDescription("Aus den Kontakten gewählt.");
  // Name und USt-IdNr. aus dem Kontakt: Die USt-IdNr. liegt in „Weitere Angaben“, deren Überschrift sie zugeklappt zeigt
  await expect(page.locator("details.weitere-angaben > summary")).toContainText("USt-IdNr. DE812871812");
  await expect(page.getByLabel(/^USt-IdNr\. des Lieferanten/)).toHaveValue("DE812871812");

  // Lieferant direkt im Beleg anlegen (#330): Name und USt-IdNr. vom Beleg, Rolle Lieferant, Eingaben bleiben
  await page.getByLabel("Rechnungsnummer").fill("H-2026-77");
  const dialog = page.getByRole("dialog", { name: "Neuen Lieferanten anlegen" });
  await neuenLieferantenOeffnen(page);
  await expect(dialog.getByLabel("Name oder Firma")).toHaveValue("Hetzner Online GmbH");
  await expect(dialog.getByLabel("Lieferant", { exact: true })).toBeChecked();
  await expect(dialog.getByLabel("Kunde", { exact: true })).not.toBeChecked();
  // Gleiche USt-IdNr.: Haben bietet den vorhandenen Kontakt an, statt eine Dublette anzulegen
  await expect(dialog.getByRole("status")).toContainText("gibt es schon „Hetzner Online GmbH“");
  await dialog.getByRole("button", { name: "„Hetzner Online GmbH“ wählen" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Lieferant", { exact: true })).toHaveValue("Hetzner Online GmbH");

  await neuenLieferantenOeffnen(page);
  await dialog.getByLabel("Name oder Firma").fill("Druckerei Süd GmbH");
  await dialog.getByLabel("USt-IdNr.").fill("");
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Kontakt anlegen" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Lieferant", { exact: true })).toHaveValue("Druckerei Süd GmbH");
  await expect(page.getByLabel("Lieferant", { exact: true })).toHaveAccessibleDescription("Aus den Kontakten gewählt.");
  await expect(page.getByLabel("Rechnungsnummer")).toHaveValue("H-2026-77");
  // Nicht buchen: Beleg löschen und die Lieferanten archivieren, damit die folgenden Tests unverändert rechnen
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Beleg löschen");
  await page.waitForURL(/\/belege$/);
  for (const name of ["Hetzner Online GmbH", "Druckerei Süd GmbH"]) {
    await go("/kontakte?rolle=lieferant");
    await page.getByRole("link", { name: new RegExp(name) }).click();
    // Reiner Lieferant ohne gebuchten Beleg (#587): Abschnitt für Belege mit Hinweis, keiner für Rechnungen
    await expect(page.getByRole("region", { name: "Ausgaben und Belege", exact: true })).toContainText("Noch keine gebuchten Belege von diesem Kontakt.");
    await expect(page.getByRole("region", { name: "Umsatz und Rechnungen", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Archivieren" }).click();
    await expect(page.getByRole("button", { name: "Wiederherstellen" })).toBeVisible();
  }
});

test("Beleg prüfen: Lieferant im Dialog anlegen speichert den Beleg nicht mit (#1835)", async ({ browser }) => {
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "kopierwerk.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Kopierwerk Nord GmbH") }]);
  await expect(page.getByText("kopierwerk.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /kopierwerk\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  const id = page.url().split("/").pop()!;
  // Vollständig und gespeichert, danach eine Änderung: Ein Absenden des Belegs würde wirklich speichern
  await page.getByLabel("Lieferant", { exact: true }).fill("Kopierwerk Nord GmbH");
  await page.getByLabel("Rechnungsnummer").fill("KN-1");
  await page.getByLabel("Belegdatum").fill(day(-4));
  await waehleKategorie(page.getByLabel("Kategorie"), "telefon");
  await page.getByRole("group", { name: "Beträge je Steuersatz" }).getByLabel("Brutto", { exact: true }).fill("119,00");
  const speichern = page.getByRole("button", { name: "Speichern", exact: true });
  await speichern.click();
  await expect(speichern).toBeDisabled();
  await page.getByLabel("Rechnungsnummer").fill("KN-2");
  await expect(speichern).toBeEnabled();

  const sql = postgres(databaseUrlFuer(DURCHLAUF), { max: 1 });
  try {
    const stand = async () => (await sql`select invoice_number, updated_at from documents where id = ${id}`)[0];
    const vorher = await stand();
    expect(vorher?.invoice_number).toBe("KN-1");
    const dialog = page.getByRole("dialog", { name: "Neuen Lieferanten anlegen" });
    await neuenLieferantenOeffnen(page);
    await expect(dialog.getByLabel("Name oder Firma")).toHaveValue("Kopierwerk Nord GmbH");
    const aufrufe = serverAufrufe(page);
    await dialog.getByRole("button", { name: "Kontakt anlegen" }).click();
    await expect(dialog).toBeHidden();
    await aufrufe.fertig();
    // Der neue Kontakt steht im Feld, die Änderung bleibt ungespeichert: Das Absenden im Dialog erreicht das Belegformular nicht
    await expect(page.getByLabel("Lieferant", { exact: true })).toHaveAccessibleDescription("Aus den Kontakten gewählt.");
    await expect(page.getByLabel("Rechnungsnummer")).toHaveValue("KN-2");
    await expect(speichern).toBeEnabled();
    expect(await stand()).toEqual(vorher);
  } finally {
    await sql.end();
  }

  // Nicht buchen: Beleg löschen und den Lieferanten archivieren, damit die folgenden Tests unverändert rechnen
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Beleg löschen");
  await page.waitForURL(/\/belege$/);
  await go("/kontakte?rolle=lieferant");
  await page.getByRole("link", { name: /Kopierwerk Nord GmbH/ }).click();
  await page.getByRole("button", { name: "Archivieren" }).click();
  await expect(page.getByRole("button", { name: "Wiederherstellen" })).toBeVisible();
});

test("Dauerbeleg: Lieferanten suchen und direkt anlegen, ohne die Eingaben zu verlieren", async () => {
  await go("/kontakte/neu");
  await page.getByLabel("Name oder Firma").fill("Suchfirma Nord GmbH");
  await page.getByLabel("Kunde", { exact: true }).uncheck();
  await page.getByLabel("Lieferant", { exact: true }).check();
  await page.getByLabel("Ort").fill("Kiel");
  await page.getByLabel("Lieferantennummer", { exact: true }).fill("L-4711");
  await page.getByRole("button", { name: "Kontakt anlegen" }).click();
  await expect(page.getByRole("heading", { name: "Versionen" })).toBeVisible();

  // Ein Kunde mit USt-IdNr.: Wer ihn als Lieferanten anlegen will, bekommt einen Hinweis, aber keine Wahl
  await go("/kontakte/neu");
  await page.getByLabel("Name oder Firma").fill("Kundenfirma Ost AG");
  await page.getByLabel("USt-IdNr.").fill("DE123456789");
  await page.getByRole("button", { name: "Kontakt anlegen" }).click();
  await expect(page.getByRole("heading", { name: "Versionen" })).toBeVisible();

  await go("/dauerbelege/neu");
  await page.getByLabel("Bezeichnung").fill("Wartung Server");
  const kontakte = page.getByRole("combobox", { name: "Aus den Kontakten" });
  // Gesucht wird auch nach der Lieferantennummer; die Zeile zeigt Nummer und Ort
  await kontakte.fill("L-4711");
  await expect(trefferliste(page).getByRole("option")).toHaveCount(2);
  await expect(trefferliste(page).getByRole("option").first()).toContainText("Suchfirma Nord GmbH");
  await expect(trefferliste(page).getByRole("option").first()).toContainText("L-4711 · Kiel");
  await trefferliste(page).getByRole("option").first().click();
  await expect(kontakte).toHaveValue("Suchfirma Nord GmbH · Kiel");
  await expect(page.getByLabel("Lieferant", { exact: true })).toHaveValue("Suchfirma Nord GmbH");

  // Der getippte Name geht in den Dialog; nach dem Speichern ist der neue Lieferant gewählt
  await neuenLieferantenOeffnen(page, "Neufirma Süd");
  const dialog = page.getByRole("dialog", { name: "Neuen Lieferanten anlegen" });
  await expect(dialog.getByLabel("Name oder Firma")).toHaveValue("Neufirma Süd");
  await expect(dialog.getByLabel("Lieferant", { exact: true })).toBeChecked();
  await expect(dialog.getByLabel("Kunde", { exact: true })).not.toBeChecked();
  // Gleiche USt-IdNr. wie bei einem Kunden, auch mit Leerzeichen: Der Server findet ihn unter allen Kontakten. Er ist kein
  // Lieferant, also nur der Hinweis mit Link; ihn als Lieferanten zu wählen gäbe es nicht
  await dialog.getByLabel("USt-IdNr.").fill("de 123 456 789");
  await expect(dialog.getByRole("status")).toContainText("gibt es schon „Kundenfirma Ost AG“ (Kunde)");
  await expect(dialog.getByRole("link", { name: "„Kundenfirma Ost AG“ öffnen" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "„Kundenfirma Ost AG“ wählen" })).toHaveCount(0);
  await dialog.getByLabel("USt-IdNr.").fill("");
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await dialog.getByLabel("Ort").fill("Köln");
  await dialog.getByRole("button", { name: "Kontakt anlegen" }).click();
  await expect(dialog).toBeHidden();
  await expect(kontakte).toHaveValue("Neufirma Süd · Köln");
  await expect(page.getByLabel("Lieferant", { exact: true })).toHaveValue("Neufirma Süd");
  await expect(page.getByLabel("Bezeichnung")).toHaveValue("Wartung Server");
  // Der Dialog schickt das Formular nicht ab: Es steht noch auf der Seite „Neuer Dauerbeleg“
  await expect(page).toHaveURL(/\/dauerbelege\/neu$/);

  // Nicht speichern; die Lieferanten archivieren, damit die folgenden Tests unverändert rechnen
  for (const name of ["Suchfirma Nord GmbH", "Neufirma Süd", "Kundenfirma Ost AG"]) {
    await go("/kontakte");
    await page.getByRole("link", { name: new RegExp(name) }).click();
    await page.getByRole("button", { name: "Archivieren" }).click();
    await expect(page.getByRole("button", { name: "Wiederherstellen" })).toBeVisible();
  }
});

test("Vorgabe „Ohne Vorsteuerabzug“: der Beleg folgt ihr und weicht gespeichert ab (#852)", async ({ browser }) => {
  // Vorgabe in den Firmendaten setzen
  await go("/einstellungen");
  const firma = page.getByRole("form", { name: "Firmendaten" });
  await firma.getByLabel("Ohne Vorsteuerabzug (steuerfreie Umsätze nach § 4 UStG)", { exact: true }).check();
  await firma.getByRole("button", { name: "Speichern" }).click();
  await expect(firma.getByRole("status")).toContainText("Firmendaten gespeichert.");

  // Ein neuer Beleg übernimmt ohne eigene Angabe die Firmenvorgabe 0 %.
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "apotheke.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Linden-Apotheke") }]);
  await expect(page.getByText("apotheke.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /apotheke\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  const anteil = page.getByLabel("Abziehbare Vorsteuer in %", { exact: true });
  await expect(anteil).toHaveValue("");
  await expect(page.getByText(/Leer = Firmenvorgabe \(0 %\)/)).toBeVisible();

  // Am Beleg abweichend voller Abzug: bleibt nach dem Speichern und Neuladen erhalten.
  await anteil.fill("100");
  const gespeichert = page.waitForResponse((r) => r.url().includes("/_serverFn/") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  expect((await gespeichert).ok()).toBe(true);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(anteil).toHaveValue("100");

  // Aufräumen: Beleg löschen und Vorgabe zurücknehmen, damit spätere Tests regulär rechnen
  await page.getByRole("button", { name: "Löschen" }).click();
  await bestaetigen(page, "Beleg löschen");
  // Danach steht Haben auf dem nächsten offenen Beleg oder in der Liste
  await page.waitForURL(/\/belege(\/[0-9a-f-]{36})?$/);
  await go("/einstellungen");
  await firma.getByLabel("Ohne Vorsteuerabzug (steuerfreie Umsätze nach § 4 UStG)", { exact: true }).uncheck();
  await firma.getByRole("button", { name: "Speichern" }).click();
  await expect(firma.getByRole("status")).toContainText("Firmendaten gespeichert.");
});

test("Eigene Konten: anlegen, am Beleg und in der Aufteilung wählen, buchen, archivieren (#270)", async ({ browser }) => {
  await go("/einstellungen?bereich=konten");
  const karte = page.getByRole("region", { name: "Eigene Konten", exact: true });
  const neu = karte.getByRole("form", { name: "Neues Konto" });
  await expect(karte).toContainText("Noch keine eigenen Konten.");
  // Dieselbe Regel wie im Server: eine Nummer, die Haben schon belegt, wird vor dem Anlegen abgelehnt
  await neu.getByLabel("Elternkategorie").selectOption("software");
  await neu.getByLabel("Kontonummer").fill("4964");
  await neu.getByLabel("Name", { exact: true }).fill("Software: Entwicklung");
  await expect(neu).toContainText("in Haben schon belegt");
  await expect(neu.getByRole("button", { name: "Konto anlegen" })).toBeDisabled();
  await neu.getByLabel("Kontonummer").fill("4999");
  await expect(neu.getByRole("button", { name: "Konto anlegen" })).toBeEnabled();
  await neu.getByRole("button", { name: "Konto anlegen" }).click();
  await expect(page.getByText("Konto 4999 angelegt.")).toBeVisible();
  const liste = karte.getByRole("group", { name: "Eigene Konten der Firma" });
  await expect(liste).toContainText("4999");
  await expect(liste).toContainText("Software: Entwicklung");
  await ohneAxeVerstoesse(page, ["/einstellungen?bereich=konten"]);

  // Am Beleg: nur zur gewählten Kategorie, leer heißt das Konto der Kategorie
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "codewerk.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Codewerk GmbH") }]);
  await expect(page.getByText("codewerk.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /codewerk\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Lieferant", { exact: true }).fill("Codewerk GmbH");
  await page.getByLabel("Belegdatum").fill(day(-3));
  await waehleKategorie(page.getByLabel("Kategorie"), "buero");
  await expect(page.getByLabel("Eigenes Konto")).toHaveCount(0);
  await waehleKategorie(page.getByLabel("Kategorie"), "software");
  await page.getByLabel("Eigenes Konto").selectOption({ label: "4999 Software: Entwicklung" });
  await page.getByRole("group", { name: "Beträge je Steuersatz" }).getByLabel("Netto", { exact: true }).fill("100,00");
  // Kategorie gewechselt: das Konto gehört nicht mehr dazu und fällt weg
  await waehleKategorie(page.getByLabel("Kategorie"), "buero");
  await expect(page.getByLabel("Eigenes Konto")).toHaveCount(0);
  await waehleKategorie(page.getByLabel("Kategorie"), "software");
  await expect(page.getByLabel("Eigenes Konto")).toHaveValue("");

  // Aufgeteilt: je Zeile wählbar
  await page.getByRole("button", { name: "Auf mehrere Kategorien aufteilen" }).click();
  const split = page.getByRole("group", { name: "Aufteilung auf Kategorien" });
  await split.getByLabel("Eigenes Konto").first().selectOption({ label: "4999 Software: Entwicklung" });
  await split.getByRole("textbox", { name: "Netto", exact: true }).first().fill("60,00");
  await waehleKategorie(split.getByLabel("Kategorie").nth(1), "buero");
  await split.getByRole("textbox", { name: "Netto", exact: true }).nth(1).fill("40,00");
  await expect(split.getByLabel("Eigenes Konto")).toHaveCount(1);
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText(/aufgeteilt auf 2 Zeilen/)).toBeVisible();
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("group", { name: "Aufteilung auf Kategorien" }).getByLabel("Eigenes Konto").first()).toHaveValue(/.+/);

  // Gebucht: die Buchung steht auf 4999, in der Belegliste neben der Aufteilung
  // Auf dem Beleg bleiben: Ein anderer Test lässt einen Beleg offen, zu dem Haben sonst weiterspringt
  await page.getByLabel("Nach dem Buchen zum nächsten offenen Beleg").uncheck();
  await page.getByRole("button", { name: "Bestätigen und buchen" }).click();
  await bestaetigen(page, "Buchen");
  await expect(page.getByText(/Gebucht .*festgeschrieben/)).toBeVisible();
  await go(`/konten/4999?jahr=${YEAR}`);
  await expect(page.getByText("Software: Entwicklung").first()).toBeVisible();

  // Archiviert: nicht mehr zur Wahl, der gebuchte Beleg behält es
  await go("/einstellungen?bereich=konten");
  await page.getByRole("button", { name: "Konto 4999 archivieren" }).click();
  await expect(page.getByText("Konto 4999 archiviert.")).toBeVisible();
  await expect(karte).toContainText("Archiviert");
  // Ein Konto mit Belegen lässt sich nicht löschen
  await page.getByRole("button", { name: "Konto 4999 löschen" }).click();
  await bestaetigen(page, "Löschen");
  await expect(page.getByText(/wird in Belegen verwendet/)).toBeVisible();
});

vorsteuerPruefen(() => page, DURCHLAUF);

test("Leistungszeitraum: zwei Felder am Beleg, gespeichert und wieder angezeigt (#693)", async ({ browser }) => {
  test.setTimeout(180_000);
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "zeitraum.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Funknetz Mobil GmbH") }]);
  await expect(page.getByText("zeitraum.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /zeitraum\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  // Das Formular kommt nach networkidle aus einer Server-Function; ohne dieses Warten greift jeder
  // Zugriff auf die Felder ins Leere und der Test hielte den Stand für einen ohne Leistungszeitraum
  const belegdatum = page.getByLabel("Belegdatum");
  await belegdatum.waitFor({ state: "visible", timeout: 30_000 });

  await page.getByLabel("Lieferant", { exact: true }).fill("Funknetz Mobil GmbH");
  await page.getByLabel("Belegdatum").fill(day(-9));
  await waehleKategorie(page.getByLabel("Kategorie"), "telefon");
  await page.getByLabel("Netto", { exact: true }).fill("38,57");
  await weitereAngabenOeffnen(page);
  await page.getByLabel("Leistung von").fill(day(-24));
  await page.getByLabel("Leistung bis").fill(day(-9));
  // Die Meldung ist Beiwerk; der Beweis ist, dass der Zeitraum nach dem Neuladen noch steht
  const speichern = serverAufrufe(page);
  await page.getByRole("button", { name: "Speichern" }).click();
  await speichern.fertig();

  await page.reload();
  await belegdatum.waitFor({ state: "visible", timeout: 30_000 });
  // Zugeklappt nennt die Überschrift den Zeitraum; aufgeklappt stehen die beiden Felder
  await expect(page.locator("details.weitere-angaben > summary")).toContainText("Leistung");
  await weitereAngabenOeffnen(page);
  await expect(page.getByLabel("Leistung von")).toHaveValue(day(-24));
  await expect(page.getByLabel("Leistung bis")).toHaveValue(day(-9));
});

test("Beleg prüfen: Seltenes ist eingeklappt, zeigt Gesetztes in der Überschrift und klappt bei einem Fehler auf (#1253)", async ({ browser }) => {
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "weitere.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Schreibwaren Lindenhof e. K.") }]);
  await expect(page.getByText("weitere.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /weitere\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  const bereich = page.locator("details.weitere-angaben");
  const ueberschrift = bereich.locator("summary");

  // Zu: die Felder sind nicht zu sehen, die Überschrift nennt die Währung
  await expect(bereich).toHaveJSProperty("open", false);
  await expect(ueberschrift).toHaveText("Weitere Angaben: EUR");
  await expect(page.getByLabel("Fällig am")).toBeHidden();

  // Was gesetzt ist, steht auch zugeklappt in der Überschrift
  await weitereAngabenOeffnen(page);
  await page.getByLabel("Fällig am").fill(day(14));
  await ueberschrift.click();
  await expect(bereich).toHaveJSProperty("open", false);
  await expect(ueberschrift).toContainText(/EUR · fällig \d{2}\.\d{2}\.\d{4}/);

  // Pflicht: Der Erwerb braucht die USt-IdNr. des Lieferanten aus der EU, das Feld liegt dann offen
  await page.getByRole("combobox", { name: /^Wer schuldet die Umsatzsteuer/ }).selectOption("ig_erwerb");
  await expect(bereich).toHaveJSProperty("open", true);
  await expect(page.getByLabel(/^USt-IdNr\. des Lieferanten/)).toBeVisible();
  await page.getByRole("combobox", { name: /^Wer schuldet die Umsatzsteuer/ }).selectOption("");

  // Fehler: Ein zugeklappter Bereich verschluckt ihn nicht, „Bestätigen und buchen“ klappt auf und setzt den Fokus aufs Feld
  await page.getByLabel("Währung").fill("EU");
  await ueberschrift.click();
  await expect(bereich).toHaveJSProperty("open", false);
  await page.getByRole("button", { name: "Bestätigen und buchen" }).click();
  await expect(bereich).toHaveJSProperty("open", true);
  await expect(page.getByLabel("Währung")).toBeFocused();
  await expect(page.getByLabel("Währung")).toHaveAccessibleDescription(/drei Buchstaben/);

  // Barrierefrei mit aufgeklapptem Bereich, Fehlermeldung und den Details zur Umsatzsteuer, am Desktop und am Handy
  await page.getByRole("combobox", { name: /^Wer schuldet die Umsatzsteuer/ }).selectOption("eu");
  await page.getByText("Details zur Voranmeldung", { exact: true }).click();
  const vorher = page.viewportSize();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    expect(
      violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
      `Beleg mit Weiteren Angaben bei ${width} px`,
    ).toEqual([]);
  }
  if (vorher) await page.setViewportSize(vorher);

  // Der Beleg gehört nur diesem Test: die folgenden zählen die offenen Belege. Gibt es noch einen offenen, geht es dort weiter
  const belegUrl = page.url();
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Beleg löschen");
  await expect(page).not.toHaveURL(belegUrl);
});

test("Beleg prüfen: Kategorien stehen in Gruppen, ein Beispiel hilft bei der Wahl (#1253)", async ({ browser }) => {
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "gruppen.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Kopierladen Stadtmitte GmbH") }]);
  await expect(page.getByText("gruppen.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /gruppen\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  const kategorie = page.getByLabel("Kategorie");
  await kategorie.click();
  // Dieselben 35 Kategorien wie zuvor, in Gruppen geordnet; jeder Eintrag nennt seine Gruppe
  const liste = kategorie.locator("xpath=..").getByRole("option");
  await expect(liste).toHaveCount(35);
  await expect(liste.filter({ hasText: "Fahrzeug" })).toHaveCount(6);
  await expect(liste.first()).toContainText("Büro und IT");
  await expect(page.getByText("Z. B. Hosting oder Software unter „Büro und IT“")).toBeVisible();
  await kategorie.press("Escape");
  await waehleKategorie(kategorie, "kfzBetrieb");
  await expect(kategorie).toHaveValue(kategorieName("kfzBetrieb"));
  await expect(page.getByText("Z. B. Hosting oder Software unter „Büro und IT“")).toBeHidden();
  // Die Suche findet auch nach der Nummer des Kontos (#1438)
  await kategorie.fill("Telefon");
  const nummer = ((await liste.filter({ hasText: "Telefon" }).first().textContent()) ?? "").match(/^[0-9]{4}/)?.[0] ?? "";
  await kategorie.fill(nummer);
  await expect(liste).toHaveCount(1);
  await expect(liste).toContainText("Telefon");
  await kategorie.press("Escape");
  // Der Beleg gehört nur diesem Test: die folgenden zählen die offenen Belege. Gibt es noch einen offenen, geht es dort weiter
  const belegUrl = page.url();
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Beleg löschen");
  await expect(page).not.toHaveURL(belegUrl);
});

test("Beleg prüfen: Der Hinweis „Vor dem Buchen“ bleibt bei Änderungen stehen (#1253)", async ({ browser }) => {
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "hinweis.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Druckhaus Elbe GmbH") }]);
  await expect(page.getByText("hinweis.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /hinweis\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  const hinweis = page.locator(".doc-editor .banner").filter({ hasText: "Vor dem Buchen:" });
  await expect(hinweis).toContainText("Lieferant fehlt");
  await expect(hinweis).not.toContainText("Stand der letzten Speicherung");
  // Eine Änderung nimmt den Hinweis nicht weg; er sagt, dass er den letzten gespeicherten Stand meint
  await page.getByLabel("Rechnungsnummer").fill("DE-2026-17");
  await expect(hinweis).toContainText("Lieferant fehlt");
  await expect(hinweis).toContainText("Stand der letzten Speicherung.");
  // Nach dem Speichern gilt er wieder für den Beleg, wie er jetzt ist
  await page.getByLabel("Lieferant", { exact: true }).fill("Druckhaus Elbe GmbH");
  const gespeichert = page.waitForResponse((r) => r.url().includes("/_serverFn/") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  expect((await gespeichert).ok()).toBe(true);
  await expect(hinweis).not.toContainText("Lieferant fehlt");
  await expect(hinweis).not.toContainText("Stand der letzten Speicherung");
  // Der Beleg gehört nur diesem Test: die folgenden zählen die offenen Belege. Gibt es noch einen offenen, geht es dort weiter
  const belegUrl = page.url();
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Beleg löschen");
  await expect(page).not.toHaveURL(belegUrl);
});

test("Beleg prüfen: Ein Leistungsende vor dem Beginn klappt „Weitere Angaben“ auf und setzt den Fokus aufs Feld (#1253)", async ({ browser }) => {
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "zeitraum-fehler.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Schreibwaren Rosengasse e. K.") }]);
  await expect(page.getByText("zeitraum-fehler.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /zeitraum-fehler\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  const bereich = page.locator("details.weitere-angaben");
  // Der Leistungszeitraum endet vor seinem Beginn, der Bereich ist zugeklappt: Speichern klappt ihn auf, wo der Fehler steht
  await weitereAngabenOeffnen(page);
  await page.getByLabel("Leistung von").fill(day(-5));
  await page.getByLabel("Leistung bis").fill(day(-20));
  await bereich.locator("summary").click();
  await expect(bereich).toHaveJSProperty("open", false);
  await page.getByLabel("Rechnungsnummer").fill("RG-4711");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(bereich).toHaveJSProperty("open", true);
  await expect(page.getByLabel("Leistung bis")).toBeFocused();
  await expect(page.getByLabel("Leistung bis")).toHaveAccessibleDescription(/Ende der Leistung liegt vor dem Beginn/);

  // Der Beleg gehört nur diesem Test: die folgenden zählen die offenen Belege. Gibt es noch einen offenen, geht es dort weiter
  const belegUrl = page.url();
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Beleg löschen");
  await expect(page).not.toHaveURL(belegUrl);
});

test("Beleg prüfen: Erwerb mit einer zu kurzen USt-IdNr. aus der EU legt das Feld offen (#1253)", async ({ browser }) => {
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "erwerb-kurz.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Papeterie Lyon SARL") }]);
  await expect(page.getByText("erwerb-kurz.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /erwerb-kurz\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  const bereich = page.locator("details.weitere-angaben");
  // „FR1234“ hat zu wenig Zeichen nach dem Länderkennzeichen (5 bis 12, packages/core/src/zm.ts): der Server lehnt sie ab
  await weitereAngabenOeffnen(page);
  await page.getByLabel(/^USt-IdNr\. des Lieferanten/).fill("FR1234");
  await bereich.locator("summary").click();
  await expect(bereich).toHaveJSProperty("open", false);
  await page.getByRole("combobox", { name: /^Wer schuldet die Umsatzsteuer/ }).selectOption("ig_erwerb");
  await expect(bereich).toHaveJSProperty("open", true);
  await expect(page.getByLabel(/^USt-IdNr\. des Lieferanten/)).toBeVisible();

  // Der Beleg gehört nur diesem Test: die folgenden zählen die offenen Belege. Gibt es noch einen offenen, geht es dort weiter
  const belegUrl = page.url();
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Beleg löschen");
  await expect(page).not.toHaveURL(belegUrl);
});

test("Beleg prüfen: Ein Fehler des Servers zu einem Feld in „Weitere Angaben“ klappt den Bereich auf (#1253)", async ({ browser }) => {
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "erwerb-server.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Papeterie Bordeaux SARL") }]);
  await expect(page.getByText("erwerb-server.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /erwerb-server\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  const bereich = page.locator("details.weitere-angaben");
  const ustId = page.getByLabel(/^USt-IdNr\. des Lieferanten/);
  // Gespeicherter Erwerb, dem nur eine gültige USt-IdNr. fehlt: „FR1234“ hat nach dem Länderkennzeichen zu wenig Zeichen
  await page.getByLabel("Lieferant", { exact: true }).fill("Papeterie Bordeaux SARL");
  await page.getByLabel("Belegdatum").fill(day(-5));
  await waehleKategorie(page.getByLabel("Kategorie"), "buero");
  await page.getByLabel("Netto", { exact: true }).fill("100,00");
  await weitereAngabenOeffnen(page);
  await ustId.fill("FR1234");
  await page.getByRole("combobox", { name: /^Wer schuldet die Umsatzsteuer/ }).selectOption("ig_erwerb");
  const gespeichert = page.waitForResponse((r) => r.url().includes("/_serverFn/") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  expect((await gespeichert).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Speichern", exact: true })).toBeDisabled();

  // Der Hinweis „Vor dem Buchen“ nennt die USt-IdNr.: Das Feld liegt offen
  await expect(page.locator(".doc-editor .banner").filter({ hasText: "Vor dem Buchen:" })).toContainText("FR1234");
  await expect(bereich).toHaveJSProperty("open", true);
  await expect(ustId).toBeVisible();

  // Zugeklappt lehnt der Server das Buchen ab: Seine Meldung klappt den Bereich wieder auf
  await bereich.locator("summary").click();
  await expect(bereich).toHaveJSProperty("open", false);
  await page.getByRole("button", { name: "Bestätigen und buchen" }).click();
  await bestaetigen(page, "Buchen");
  await expect(page.locator(".doc-actions").getByText(/Noch nicht bereit: .*FR1234/)).toBeVisible();
  await expect(bereich).toHaveJSProperty("open", true);
  await expect(ustId).toBeVisible();

  // Der Beleg gehört nur diesem Test: die folgenden zählen die offenen Belege. Gibt es noch einen offenen, geht es dort weiter
  const belegUrl = page.url();
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Beleg löschen");
  await expect(page).not.toHaveURL(belegUrl);
});

/**
 * Im Browser: wartet, bis jedes schon angestoßene toggle-Ereignis eines `<details>` gemeldet ist. Der Browser reiht es als
 * Aufgabe der Quelle „DOM manipulation“ ein (HTML-Standard, „queue a details toggle event task“); das einer Sonde, die erst
 * danach aufklappt, kommt aus derselben Quelle und damit nach allen früheren
 */
async function toggleAbwarten(): Promise<void> {
  const sonde = document.createElement("details");
  document.body.append(sonde);
  await new Promise((resolve) => {
    sonde.addEventListener("toggle", resolve, { once: true });
    sonde.open = true;
  });
  sonde.remove();
}

test("Beleg prüfen: Zuklappen und Wahl im selben Bild lassen „Weitere Angaben“ offen (#1253)", async ({ browser }) => {
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "gleichzeitig.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Papeterie Nantes SARL") }]);
  await expect(page.getByText("gleichzeitig.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /gleichzeitig\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  const bereich = page.locator("details.weitere-angaben");
  await weitereAngabenOeffnen(page);
  await page.getByLabel(/^USt-IdNr\. des Lieferanten/).fill("FR1234");
  // Das Ereignis des Aufklappens ist durch: der Zustand der Seite ist „offen“
  await page.evaluate(toggleAbwarten);
  // Der Browser meldet das Zuklappen erst mit einem späteren toggle-Ereignis: Wer im selben Bild den Erwerb wählt, braucht
  // das Feld offen. Jedes toggle-Ereignis des Bereichs hält fest, ob er danach offen ist
  await page.evaluate(() => {
    const details = document.querySelector<HTMLDetailsElement>("details.weitere-angaben")!;
    const offen: boolean[] = [];
    (window as unknown as { toggleOffen: boolean[] }).toggleOffen = offen;
    details.addEventListener("toggle", () => offen.push(details.open));
    const frage = [...document.querySelectorAll("select")].find((el) => el.closest(".field")?.textContent?.startsWith("Wer schuldet"))!;
    details.querySelector("summary")!.click();
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(frage, "ig_erwerb");
    frage.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.evaluate(toggleAbwarten);
  // Kein Ereignis hat ihn zugeklappt, und er steht offen
  expect(await page.evaluate(() => (window as unknown as { toggleOffen: boolean[] }).toggleOffen)).not.toContain(false);
  await expect(bereich).toHaveJSProperty("open", true);
  // Mit der Tastatur: Enter klappt zu, Leertaste auf
  await bereich.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(bereich).toHaveJSProperty("open", false);
  await page.keyboard.press("Space");
  await expect(bereich).toHaveJSProperty("open", true);

  // Der Beleg gehört nur diesem Test: die folgenden zählen die offenen Belege. Gibt es noch einen offenen, geht es dort weiter
  const belegUrl = page.url();
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await bestaetigen(page, "Beleg löschen");
  await expect(page).not.toHaveURL(belegUrl);
});

// Die vier Tests zu #1824 teilen sich einen Beleg und stehen am Ende: Der letzte bucht ihn, die Tests davor zählen offene Belege
test("Beleg prüfen: Eingaben direkt nach dem Speichern bleiben erhalten (#1824)", async ({ browser }) => {
  await go("/belege");
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles([{ name: "sperre.jpg", mimeType: "image/jpeg", buffer: await receiptJpeg(browser, "Papierhaus Sperre GmbH") }]);
  await expect(page.getByText("sperre.jpg: abgelegt.")).toBeVisible();
  await page
    .getByRole("link", { name: /sperre\.jpg/ })
    .first()
    .click();
  await page.waitForURL(/belege\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  const nummer = page.getByLabel("Rechnungsnummer");
  await page.getByLabel("Lieferant", { exact: true }).fill("Papierhaus Sperre GmbH");
  await nummer.fill("PS-0001");
  await eingabeNachAktion(page, {
    aktion: page.locator(".doc-actions").getByRole("button", { name: "Speichern" }),
    feld: nummer,
    text: "Gleich danach getippt",
    // Vor dem ersten Speichern heißt die Seite „Neuer Beleg“
    neuGeladen: page.getByRole("heading", { name: "Papierhaus Sperre GmbH", level: 1 }),
  });
});

test("Beleg prüfen: Kurz nacheinander gespeichert, baut sich das Formular jedes Mal neu auf (#1824)", async () => {
  // Der Beleg aus dem Test davor
  await kurzNacheinanderSpeichern({
    feld: page.getByLabel("Rechnungsnummer"),
    speichern: page.locator(".doc-actions").getByRole("button", { name: "Speichern" }),
    texte: ["PS-eins", "PS-zwei", "PS-drei"],
  });
});

test("Beleg prüfen: Speichern schlägt fehl, der Fokus steht danach wieder im Feld (#1824)", async () => {
  // Der Beleg aus den Tests davor; Enter speichert nur mit Änderungen, sonst ist „Speichern“ gesperrt
  const nummer = page.getByLabel("Rechnungsnummer");
  await nummer.fill("PS-Fehler");
  await fokusNachFehlschlag(page, nummer);
});

test("Beleg prüfen: Nach dem Buchen werden die Felder bis zum Neuaufbau nicht frei (#1824)", async () => {
  // Der Beleg aus den Tests davor; auf ihm bleiben, damit die Seite ihn neu lädt statt zum nächsten zu wechseln
  await page.getByLabel("Belegdatum").fill(day(-2));
  await waehleKategorie(page.getByLabel("Kategorie"), "buero");
  await page.getByLabel("Netto", { exact: true }).fill("42,00");
  await page.getByLabel("Nach dem Buchen zum nächsten offenen Beleg").uncheck();
  await page.getByRole("button", { name: "Bestätigen und buchen" }).click();
  await gesperrtBisNeuGeladen(page, {
    aktion: page.getByRole("dialog").getByRole("button", { name: "Buchen", exact: true }),
    feld: page.getByLabel("Rechnungsnummer"),
    neuGeladen: page.getByText(/Gebucht .*festgeschrieben/),
  });
});

test("Seiten mit den Daten dieses Abschnitts ohne axe-Verstöße", async () => {
  await ohneAxeVerstoesse(page, ["/belege"]);
});

test("Keine Fehler im Browser", async () => {
  expect(pageErrors).toEqual([]);
});
