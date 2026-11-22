import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { textPdf } from "../src/server/modules/belege/test-text-pdf.ts";
import { bestaetigen, durchlaufSeite, einrichten, gehe } from "./einrichtung.ts";

/** Umzug aus WISO mit Testlauf, Import und Beleg im Archiv, in eigener, leerer Datenbank (Projekt „wiso-import“, e2e/durchlaeufe.ts) */
const WISO_HEADERS = [
  "Buchungsnummer",
  "Teilbuchung",
  "Zahlungsdatum",
  "Wertstellungsdatum",
  "Buchungstext",
  "Konto",
  "Kontobezeichnung",
  "Gegenkonto",
  "Gegenkontobezeichnung",
  "Soll",
  "Haben",
  "Steuerschluessel",
  "Steuersatz",
  "Steuerschluesselbezeichnung",
  "Belegnummer",
  "Buchungsdatum",
  "UStID",
  "Umsatzart",
];

function wisoCsv(): Buffer {
  const row = [
    "101",
    "1",
    "15.03.2023",
    "15.03.2023",
    "Beratung Muster GmbH",
    "1200",
    "Bank",
    "8400",
    "Erlöse 19 % USt",
    "119,00",
    "0,00",
    "USt 19 %",
    "19,00",
    "Umsatzsteuer 19 %",
    "RE-2023-101",
    "15.03.2023",
    "",
    "0",
  ];
  return Buffer.from([WISO_HEADERS, row].map((r) => r.join(";")).join("\r\n"));
}

function wisoAssetPdf(): Buffer {
  const page = [
    "Verzeichnis der abnutzbaren Anlagegüter 2023",
    "Nr Bezeichnung Anschaffungs- Anschaffungs- Zugänge / ND AfA RBW AfA RBW Anlagen-",
    "datum kosten Teilabgänge Vorjahre Vorjahr 2023 31.12.2023 abgang",
    "410 Geschäftsausstattung",
    "  008 Rechenmaschine 27.12.2022 588,19 3 16,34 571,85 196,06 375,79",
    "Summen 588,19 16,34 571,85 196,06 375,79",
  ].join("\n");
  return Buffer.from(textPdf([page]));
}

test("WISO: Testlauf, Import und Beleg im Archiv", async ({ browser }) => {
  const { page, pageErrors } = await durchlaufSeite(browser);
  await einrichten(page);
  await gehe(page, "/archiv");
  await page.getByRole("button", { name: "Umzug aus WISO", exact: true }).click();
  const card = page.getByRole("region", { name: "WISO-Buchungen als CSV prüfen und importieren" });
  await card.getByLabel("WISO-Buchungs-CSV").setInputFiles({
    name: "wiso-buchungen.csv",
    mimeType: "text/csv",
    buffer: wisoCsv(),
  });
  await card.getByRole("button", { name: "Testlauf starten" }).click();
  await expect(card.locator(".facts")).toContainText("2023", { timeout: 30_000 });
  await expect(card.locator(".facts")).toContainText("1");
  await card.getByRole("button", { name: "Diese Daten importieren" }).click();
  await bestaetigen(page, "Import starten");
  await expect(card.getByText(/Import abgeschlossen: 1 Buchungen übernommen/)).toBeVisible({ timeout: 60_000 });

  await page.getByRole("navigation", { name: "Bereich wählen" }).getByRole("link", { name: "Belege", exact: true }).click();
  // WISO liefert keine Dateien, jede Buchung ist „ohne Beleg“. Zu tun gibt es nichts (bestätigen lässt sich das nicht),
  // deshalb bleibt der Status ruhig (DESIGN.md › Status, Stufe): sonst stünde jede Zeile der Liste in Warnfarbe
  const zeile = page.getByRole("link", { name: /RE-2023-101/ });
  const ohneBeleg = zeile.locator(".status").filter({ hasText: "Ohne Beleg" });
  await expect(ohneBeleg).toHaveCount(1);
  await expect(ohneBeleg).not.toHaveClass(/status-notice/);
  await page.getByRole("link", { name: /RE-2023-101/ }).click();
  await expect(page.getByRole("heading", { name: /RE-2023-101/ })).toBeVisible();

  await gehe(page, "/archiv");
  await page.getByRole("button", { name: "Umzug aus WISO", exact: true }).click();
  const assets = page.getByRole("region", { name: "WISO-Anlagenverzeichnis als PDF prüfen" });
  await assets.getByLabel("WISO-Anlagenverzeichnis").setInputFiles({ name: "Anlagen.pdf", mimeType: "application/pdf", buffer: wisoAssetPdf() });
  await assets.getByRole("button", { name: "Anlagen prüfen" }).click();
  await expect(assets.getByRole("row", { name: /008 Rechenmaschine/ })).toContainText("375,79");
  const pendingDownload = page.waitForEvent("download");
  await assets.getByRole("button", { name: "CSV-Entwurf laden" }).click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toBe("WISO-Anlagen-2023-Entwurf.csv");
  const csv = await readFile((await download.path())!, "utf8");
  await assets.getByRole("link", { name: "Zum Anlagenimport" }).click();
  await expect(page.getByLabel("Übernahmestichtag")).toHaveValue("2024-01-01");

  const datei = page.getByLabel("CSV-Datei");
  const vorschau = page.getByRole("button", { name: "Vorschau", exact: true });
  await datei.setInputFiles({ name: "Entwurf.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await vorschau.click();
  await expect(page.getByText(/Art: .*Bitte ergänzen/)).toBeVisible();
  const ergaenzt = csv.replace("Bitte ergänzen;Bitte ergänzen", "Sonstiges;linear");
  await datei.setInputFiles({ name: "Ergaenzt.csv", mimeType: "text/csv", buffer: Buffer.from(ergaenzt) });
  await vorschau.click();
  await expect(page.getByRole("row", { name: /Rechenmaschine/ })).toContainText("Neu");
  expect(pageErrors).toEqual([]);
});
