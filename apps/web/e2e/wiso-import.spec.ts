import { expect, test, type Locator, type Page } from "@playwright/test";
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

function wisoCsv(amount = "119,00"): Buffer {
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
    amount,
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

async function gobdAbgleichen(page: Page) {
  const abgleich = page.getByRole("region", { name: "WISO-GoBD-Dateien abgleichen" });
  await abgleich.getByLabel("GoBD-Buchungsliste").setInputFiles({
    name: "buchungsliste.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Konto;Gegenkonto;Betrag;SollHaben\n1200;8400;119,00;S\n8400;1200;119,00;H"),
  });
  const susa = abgleich.getByLabel("GoBD-Summen- und Saldenliste");
  const report = (betrag: string) => ({
    name: "susa.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "KontoNummer;AnfangssaldoSoll;AnfangssaldoHaben;BuchungsSummeSoll;BuchungsSummeHaben;SaldoSoll;SaldoHaben\n" +
        `1200;0;0;${betrag};0;0;${betrag}\n8400;0;0;0;119,00;119,00;0`,
    ),
  });
  const submit = abgleich.getByRole("button", { name: "Dateien abgleichen" });
  await susa.setInputFiles(report("118,00"));
  await submit.click();
  const differences = abgleich.getByRole("table", { name: "Abweichungen je Konto" });
  const movement = differences.getByRole("row", { name: /1200 Buchungssumme Soll/ });
  await expect(movement).toContainText("119,00");
  await expect(movement).toContainText("118,00");
  await susa.setInputFiles(report("119,00"));
  await expect(differences).toHaveCount(0);
  await submit.click();
  await expect(abgleich.getByRole("status")).toContainText("Buchungsliste und SuSa stimmen überein.");
}

async function fehlerzeilenPruefen(card: Locator) {
  const file = card.getByLabel("WISO-Buchungs-CSV");
  const testlauf = card.getByRole("button", { name: "Testlauf starten" });
  const uebernehmen = card.getByRole("button", { name: "Diese Daten importieren" });
  const invalidDateRow = wisoCsv().toString().split("\r\n")[1]!.replace("15.03.2023", "kein Datum");
  await file.setInputFiles({
    name: "wiso-fehler.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`${wisoCsv("kein Betrag")}\r\n\r\n${invalidDateRow}`),
  });
  await testlauf.click();
  await expect(card.getByRole("alert")).toContainText("Zeile 2: ungültiger Betrag in Soll.");
  await expect(card.getByRole("alert")).toContainText("Zeile 4: ungültiges Zahlungsdatum.");
  await expect(uebernehmen).toHaveCount(0);
}

async function dateiwechselPruefen(page: Page, card: Locator) {
  const file = card.getByLabel("WISO-Buchungs-CSV");
  const testlauf = card.getByRole("button", { name: "Testlauf starten" });
  const uebernehmen = card.getByRole("button", { name: "Diese Daten importieren" });
  for (const amount of ["239,00", "kein Betrag"]) {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const oldFile = `wiso-alt-${amount}.csv`;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.postData()?.includes(`filename="${oldFile}"`)) {
        started.resolve();
        await release.promise;
      }
      await route.continue();
    });
    await file.setInputFiles({ name: oldFile, mimeType: "text/csv", buffer: wisoCsv(amount) });
    await expect(card.getByRole("alert")).toHaveCount(0, { timeout: 2_000 });
    await testlauf.click();
    try {
      await started.promise;
      await file.setInputFiles({ name: "wiso-buchungen.csv", mimeType: "text/csv", buffer: wisoCsv() });
    } finally {
      release.resolve();
    }
    await expect(testlauf).toBeEnabled();
    await expect(uebernehmen).toHaveCount(0);
    await expect(card.getByRole("alert")).toHaveCount(0);
  }
}

test("WISO: Testlauf, Import und Beleg im Archiv", async ({ browser }) => {
  const { page, pageErrors } = await durchlaufSeite(browser);
  await einrichten(page);
  await gehe(page, "/archiv");
  await page.getByRole("button", { name: "Umzug aus WISO", exact: true }).click();
  await gobdAbgleichen(page);
  const card = page.getByRole("region", { name: "WISO-Buchungen als CSV prüfen und importieren" });
  await fehlerzeilenPruefen(card);
  await dateiwechselPruefen(page, card);
  const testlauf = card.getByRole("button", { name: "Testlauf starten" });
  const uebernehmen = card.getByRole("button", { name: "Diese Daten importieren" });
  await testlauf.click();
  await expect(card.locator(".facts")).toContainText("2023", { timeout: 30_000 });
  await expect(card.locator(".facts")).toContainText("1");
  await expect(card.locator(".facts > div", { hasText: "Soll laut CSV" })).toContainText("119,00 €");
  await expect(card.locator(".facts > div", { hasText: "Haben laut CSV" })).toContainText("0,00 €");
  await uebernehmen.click();
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
  expect(pageErrors).toEqual([]);
});
