import { expect, type Page, test } from "@playwright/test";
import { CUSTOMERS, durchlaufSeite, einrichten, gehe, INVOICES, kontaktAnlegen, rechnungFestschreiben } from "./einrichtung.ts";

import { abzugSichern } from "./abzug.ts";

/**
 * Rechnungen, Angebote und Kasse in eigener, leerer Datenbank (Projekt „rechnungen“, e2e/durchlaeufe.ts), parallel zu
 * app.spec.ts. Hier nur dieselbe Einrichtung, dieselben drei Kunden und eine festgeschriebene Rechnung wie in app.spec.ts;
 * der Abzug danach (e2e/abzug.ts) ist der Anfang der Abschnitte rechnungen-*.spec.ts, die parallel mit je eigenem Server
 * laufen (ABZUG_AUS in e2e/durchlaeufe.ts).
 */
test.describe.configure({ mode: "serial" });

let page: Page;
let pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  ({ page, pageErrors } = await durchlaufSeite(browser));
});

test.afterAll(async () => {
  await page.context().close();
});

const _go = (path: string) => gehe(page, path);

test("Einrichtung mit drei Kunden und einer festgeschriebenen Rechnung", async () => {
  await einrichten(page);
  for (const kunde of CUSTOMERS) await kontaktAnlegen(page, kunde);
  // „Rechnung per E-Mail“ verschickt die erste festgeschriebene Rechnung der Liste
  await rechnungFestschreiben(page, INVOICES[0]!);
});

test("Keine Fehler im Browser", async () => {
  expect(pageErrors).toEqual([]);
});

test("Abzug für die Abschnitte sichern", async () => {
  await abzugSichern("rechnungen", page.context());
});
