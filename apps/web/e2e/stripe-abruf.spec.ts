import { createServer, type Server } from "node:http";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { databaseUrlFuer, STRIPE_PORT } from "./durchlaeufe.ts";
import { axeVerstoesse, durchlaufSeite, einrichten, gehe, kontoVerbinden } from "./einrichtung.ts";

/**
 * Stripe (#1280, #1729) in eigener, leerer Datenbank (Projekt „stripe-abruf“, e2e/durchlaeufe.ts), verbunden über die
 * geführte Einrichtung (#1951): Anbieter wählen, Schlüssel des Testmodus abgelehnt, Live-Schlüssel geprüft, ohne zu
 * speichern, Verbindung gespeichert und Balance Transactions im ersten Abruf ins Konto des Zahlungsdienstleisters; ein schon
 * verbundenes Konto beim Prüfen erkannt; Verbindung auf der Bankseite abgerufen und entfernt. Nur der Server dieses Durchlaufs fragt die nachgebaute API unten
 * (STRIPE_API_URL in playwright.config.ts): eine Zahlung mit Gebühr und eine Auszahlung.
 */

test.describe.configure({ mode: "serial" });

const KONTO = "acct_1E2eBeispiel";
const SCHLUESSEL = ["rk", "live", "e2eBeispielSchluessel4711"].join("_"); // zusammengesetzt, damit GitHubs Geheimnis-Scanner ihn nicht für echt hält

let page: Page;
let pageErrors: string[] = [];
let stripe: Server;
/** Was Haben an die nachgebaute API geschickt hat: Methode, Pfad mit Abfrage und der Schlüssel aus dem Kopf */
const anfragen: { pfad: string; schluessel: string }[] = [];

function bewegungen() {
  const jetzt = Math.floor(Date.now() / 1000) - 60;
  return [
    {
      id: "txn_e2eZahlung",
      object: "balance_transaction",
      amount: 11900,
      created: jetzt,
      currency: "eur",
      description: "Rechnung 2026-101",
      fee: 400,
      net: 11500,
      reporting_category: "charge",
      source: { id: "ch_e2eZahlung", object: "charge", billing_details: { name: "Studio Süd", email: null }, description: "Rechnung 2026-101" },
      status: "available",
      type: "charge",
    },
    {
      id: "txn_e2eAuszahlung",
      object: "balance_transaction",
      amount: -5000,
      created: jetzt,
      currency: "eur",
      description: "STRIPE PAYOUT",
      fee: 0,
      net: -5000,
      reporting_category: "payout",
      source: { id: "po_e2eAuszahlung", object: "payout" },
      status: "pending",
      type: "payout",
    },
  ];
}

/** Nachgebaute Stripe-API: Konto zum Schlüssel und eine Seite Balance Transactions */
async function stripeAttrappe(): Promise<Server> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    anfragen.push({ pfad: `${request.method} ${url.pathname}${url.search}`, schluessel: request.headers.authorization ?? "" });
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== `Bearer ${SCHLUESSEL}`)
      return json(401, { error: { message: "Invalid API Key provided", type: "invalid_request_error" } });
    if (url.pathname === "/v1/account") return json(200, { id: KONTO, object: "account" });
    if (url.pathname === "/v1/balance_transactions") return json(200, { object: "list", data: bewegungen(), has_more: false });
    json(404, { error: { message: "nicht nachgebaut" } });
  });
  await new Promise<void>((resolve) => server.listen(STRIPE_PORT, "127.0.0.1", resolve));
  return server;
}

test.beforeAll(async ({ browser }) => {
  ({ page, pageErrors } = await durchlaufSeite(browser));
  stripe = await stripeAttrappe();
});

test.afterAll(async () => {
  await page.context().close();
  await new Promise((resolve) => stripe?.close(resolve));
});

test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

const zugang = () => page.getByRole("form", { name: "Zugang" });
const geprueft = () => page.getByRole("status", { name: "Zugang geprüft" });
const shop = () => page.getByRole("region", { name: "Automatischer Abruf" }).getByRole("region", { name: "Shop DE", exact: true });

async function mitDatenbank<T>(arbeit: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(databaseUrlFuer("stripe-abruf"), { max: 1, onnotice: () => {} });
  try {
    return await arbeit(sql);
  } finally {
    await sql.end();
  }
}

test("Einrichtung", async () => {
  await einrichten(page);
});

test("„Konto verbinden › Zahlungsdienstleister verbinden“: Anbieter wählen, die ohne Abruf ausgegraut mit Grund", async () => {
  await gehe(page, "/bank");
  await kontoVerbinden(page, "Zahlungsdienstleister verbinden");
  const dialog = page.getByRole("dialog", { name: "Anbieter wählen" });
  const stripeWahl = dialog.getByRole("radio", { name: "Stripe" });
  await expect(stripeWahl).toBeChecked();
  await expect(stripeWahl).toHaveAccessibleDescription("API-Schlüssel · 3 Schritte · noch nicht verbunden");
  await expect(dialog.getByRole("radio", { name: "PayPal" })).toBeEnabled();
  await expect(dialog.getByRole("radio", { name: "Etsy Payments" })).toBeDisabled();
  await expect(dialog.getByRole("radio", { name: "Etsy Payments" })).toHaveAccessibleDescription("Etsy verbindest du unter Einstellungen › Bank.");
  await expect(dialog.getByRole("radio", { name: "Shopify Payments" })).toHaveAccessibleDescription(
    "Noch kein Abruf; die Umsätze kommen als Datei über „CSV / CAMT importieren“.",
  );
  expect(await axeVerstoesse(page), "Dialog „Anbieter wählen“").toEqual([]);
  await dialog.getByRole("button", { name: "Weiter" }).click();

  await page.waitForURL(/\/bank\/verbinden\/stripe$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stripe verbinden");
  const schritte = page.getByRole("list", { name: "Schritte" }).getByRole("listitem");
  await expect(schritte).toHaveText(["1 · Zugang", "2 · Name und Zeitraum", "3 · Erster Abruf"]);
  await expect(schritte.first()).toHaveAttribute("aria-current", "step");
  expect(await axeVerstoesse(page), "Einrichtung, Schritt Zugang").toEqual([]);
});

test("Ein Schlüssel des Testmodus wird beim Prüfen abgelehnt, ohne Stripe zu fragen", async () => {
  await zugang().getByLabel("API-Schlüssel").fill(["rk", "test", "e2eBeispielSchluessel4711"].join("_"));
  await zugang().getByRole("button", { name: "Zugang prüfen" }).click();
  await expect(zugang().getByRole("alert")).toContainText("Haben ruft nur Live-Umsätze ab; bitte einen Live-Schlüssel mit Leserechten eintragen.");
  await expect(zugang().getByRole("button", { name: "Weiter" })).toHaveCount(0);
  expect(anfragen).toEqual([]);
});

test("Zugang prüfen nennt das Konto bei Stripe und speichert nichts; Name und Zeitraum; der erste Abruf läuft im letzten Schritt", async () => {
  await zugang().getByLabel("API-Schlüssel").fill(SCHLUESSEL);
  // Die Eingabe nimmt die Meldung der letzten Prüfung weg
  await expect(zugang().getByRole("alert")).toHaveCount(0);
  await zugang().getByRole("button", { name: "Zugang prüfen" }).click();
  await expect(geprueft()).toContainText(`Stripe-Konto ${KONTO} (Schlüssel …4711).`);
  await expect(geprueft()).toContainText("OK");
  expect(anfragen.map((a) => a.pfad)).toEqual(["GET /v1/account"]);
  expect(await mitDatenbank((sql) => sql`select count(*)::int as n from psp_connections`)).toEqual([{ n: 0 }]);
  await zugang().getByRole("button", { name: "Weiter" }).click();

  const einstellungen = page.getByRole("form", { name: "Name und Zeitraum" });
  await expect(page.getByRole("listitem").filter({ hasText: "2 · Name und Zeitraum" })).toHaveAttribute("aria-current", "step");
  await expect(einstellungen.getByLabel("Name")).toHaveValue("Stripe");
  // Ohne Namen: Fehler am Feld, der Fokus steht im Feld (DESIGN.md, Gesperrte Knöpfe)
  await einstellungen.getByLabel("Name").fill("");
  await einstellungen.getByRole("button", { name: "Speichern und abrufen" }).click();
  await expect(einstellungen.getByText("Gib der Verbindung einen Namen.")).toBeVisible();
  await expect(einstellungen.getByLabel("Name")).toBeFocused();
  await einstellungen.getByLabel("Name").fill("Shop DE");
  // Kein Konto des Anbieters: Haben sagt, welches entsteht
  await expect(einstellungen).toContainText("Haben legt das Konto „Shop DE“ der Art Zahlungsdienstleister an.");
  expect(await axeVerstoesse(page), "Einrichtung, Schritt Name und Zeitraum").toEqual([]);
  await einstellungen.getByRole("button", { name: "Speichern und abrufen" }).click();

  const ergebnis = page.getByRole("region", { name: "Erster Abruf" });
  await expect(ergebnis.getByText("Fertig", { exact: true })).toBeVisible();
  await expect(ergebnis).toContainText("2 Bewegungen beim Anbieter, 3 neue Umsätze im Konto „Shop DE“.");
  expect(await axeVerstoesse(page), "Einrichtung, Schritt Erster Abruf").toEqual([]);

  const abruf = anfragen.find((a) => a.pfad.startsWith("GET /v1/balance_transactions"));
  expect(abruf?.pfad).toContain("expand%5B%5D=data.source");
  expect(abruf?.schluessel).toBe(`Bearer ${SCHLUESSEL}`);
  await mitDatenbank(async (sql) => {
    const [zeile] =
      await sql`select provider, name, account_id, key_hint, position('e2eBeispiel' in encode(ciphertext, 'escape')) as klartext from psp_connections`;
    expect(zeile).toEqual({ provider: "stripe", name: "Shop DE", account_id: KONTO, key_hint: "4711", klartext: 0 });
    const umsaetze = await sql`select bank_reference, amount, counterparty_name from bank_transactions order by bank_reference`;
    expect(umsaetze.map((u) => [u.bank_reference, Number(u.amount)])).toEqual([
      ["txn_e2eAuszahlung", -5000],
      ["txn_e2eZahlung", 11900],
      ["txn_e2eZahlung-gebuehr", -400],
    ]);
    expect(umsaetze.find((u) => u.bank_reference === "txn_e2eZahlung")?.counterparty_name).toBe("Studio Süd");
  });

  // „Zum Konto“: die Bankseite mit der Karte des neuen Kontos gewählt, die Verbindung über seiner Liste
  await ergebnis.getByRole("link", { name: "Zum Konto" }).click();
  const karte = page.getByRole("navigation", { name: "Konten" }).getByRole("link", { name: /^Shop DE/ });
  await expect(karte).toHaveAttribute("aria-current", "page");
  await expect(karte).toContainText("Stripe · heute");
  await expect(shop().getByText(`Stripe: verbunden mit ${KONTO} (Schlüssel …4711).`)).toBeVisible();
  await expect(page.getByText("Studio Süd").first()).toBeVisible();
});

test("Ein schon verbundenes Konto erkennt die Prüfung, mit dem Namen der Verbindung", async () => {
  await kontoVerbinden(page, "Zahlungsdienstleister verbinden");
  const dialog = page.getByRole("dialog", { name: "Anbieter wählen" });
  await expect(dialog.getByRole("radio", { name: "Stripe" })).toHaveAccessibleDescription("API-Schlüssel · 3 Schritte · verbunden: „Shop DE“");
  await dialog.getByRole("button", { name: "Weiter" }).click();
  await zugang().getByLabel("API-Schlüssel").fill(SCHLUESSEL);
  await zugang().getByRole("button", { name: "Zugang prüfen" }).click();
  await expect(geprueft()).toContainText("Schon verbunden");
  await expect(geprueft()).toContainText("Dieses Stripe-Konto ist schon als „Shop DE“ verbunden.");
  await expect(zugang().getByRole("button", { name: "Weiter" })).toHaveCount(0);
  await geprueft().getByRole("link", { name: "Zur Verbindung" }).click();
  await expect(page.getByRole("navigation", { name: "Konten" }).getByRole("link", { name: /^Shop DE/ })).toHaveAttribute("aria-current", "page");
  expect(await mitDatenbank((sql) => sql`select count(*)::int as n from psp_connections`)).toEqual([{ n: 1 }]);
});

test("Jetzt abrufen an der Verbindung legt nichts doppelt an; Bearbeiten zeigt den Schlüssel nicht", async () => {
  await shop().getByRole("button", { name: "Jetzt abrufen" }).click();
  await expect(shop().getByText("Abruf durchgelaufen.")).toBeVisible();
  await expect(shop().getByText(/Letzter Abruf: /)).toBeVisible();
  expect(await mitDatenbank((sql) => sql`select count(*)::int as n from bank_transactions`)).toEqual([{ n: 3 }]);
  await shop().getByRole("button", { name: "Bearbeiten" }).click();
  await expect(shop().getByLabel("API-Schlüssel (leer lassen zum Behalten)")).toHaveValue("");
  await shop().getByRole("button", { name: "Abbrechen" }).click();
});

test("Verbindung entfernen löscht den Schlüssel, die Umsätze bleiben", async () => {
  const abruf = page.getByRole("region", { name: "Automatischer Abruf" });
  await shop().getByRole("button", { name: "Verbindung entfernen" }).click();
  const dialog = page.getByRole("dialog", { name: "Verbindung Shop DE entfernen?" });
  await dialog.getByRole("button", { name: "Entfernen" }).click();
  await expect(abruf.getByText("Verbindung entfernt. Übernommene Umsätze bleiben im Konto stehen.")).toBeVisible();
  await expect(shop()).toHaveCount(0);
  expect(await mitDatenbank((sql) => sql`select count(*)::int as n from psp_connections`)).toEqual([{ n: 0 }]);
  expect(await mitDatenbank((sql) => sql`select count(*)::int as n from bank_transactions`)).toEqual([{ n: 3 }]);
  // Einstellungen › Bank verweist auf die Bankseite statt einer eigenen Karte
  await gehe(page, "/einstellungen?bereich=bank");
  const hinweis = page.getByRole("region", { name: "Zahlungsdienstleister", exact: true });
  await expect(hinweis).toContainText("Stripe und PayPal verbindest du auf der Seite Bank");
  await expect(hinweis.getByRole("button")).toHaveCount(0);
});
