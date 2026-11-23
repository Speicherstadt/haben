import { expect, type Page, test } from "@playwright/test";
import { TEST_PIN, testZertifikatsdatei } from "../src/test-fixtures/elster-zertifikat.ts";
import { YEAR } from "./daten.ts";
import { durchlaufSeite, einrichten, gehe } from "./einrichtung.ts";
import { abzugSichern } from "./abzug.ts";

/**
 * Belege, Bank und Steuern in eigener, leerer Datenbank (Projekt „belege-steuern“, e2e/durchlaeufe.ts), parallel zu
 * app.spec.ts. Hier nur die Einrichtung wie in app.spec.ts und die Steuerdaten mit ELSTER-Zertifikat; der Abzug danach
 * (e2e/abzug.ts) ist der Anfang der Abschnitte belege-steuern-*.spec.ts, die parallel mit je eigenem Server laufen
 * (ABZUG_AUS in e2e/durchlaeufe.ts).
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

const go = (path: string) => gehe(page, path);

test("Einrichtung", async () => {
  await einrichten(page);
});

test("Steuerdaten hinterlegen und Belege von ELSTER testweise abrufen", async () => {
  await go("/einstellungen?bereich=persoenlich");
  const taxpayer = page.getByRole("form", { name: "Persönliche Angaben" });
  await taxpayer.getByLabel("Steuer-ID").fill("65929970489");
  await taxpayer.getByLabel("Vorname").fill("Max");
  await taxpayer.getByLabel("Nachname").fill("Mustermann");
  await taxpayer.getByLabel("Geburtsdatum").fill("1985-04-12");
  await taxpayer.getByLabel("Art").selectOption("zusammen");
  const ehegatte = taxpayer.getByRole("group", { name: "Ehegatte (Person B)" });
  await ehegatte.getByLabel("Anrede").selectOption("Frau");
  await ehegatte.getByLabel("Steuer-ID").fill("86095742719");
  await ehegatte.getByLabel("Vorname").fill("Erika");
  await ehegatte.getByLabel("Nachname").fill("Mustermann");
  await ehegatte.getByLabel("Geburtsdatum").fill("1987-03-01");
  await taxpayer.getByRole("button", { name: "Speichern" }).click();
  await expect(taxpayer.getByRole("status")).toBeVisible();
  await go("/einstellungen?bereich=elster");
  const cert = page.getByRole("form", { name: "ELSTER-Zertifikat" });
  // Mit der PIN liest Haben das Ablaufdatum aus der Datei (#1366); die Testdatei ist aufgebaut wie eine aus Mein ELSTER
  await cert
    .getByLabel("Zertifikatsdatei")
    .setInputFiles({ name: "test.pfx", mimeType: "application/x-pkcs12", buffer: Buffer.from(testZertifikatsdatei("rc2-40")) });
  await cert.getByLabel("Zertifikats-PIN (optional)").fill(TEST_PIN);
  await cert.getByRole("button", { name: "Hochladen" }).click();
  await expect(cert.getByRole("status")).toHaveText("Zertifikat verschlüsselt gespeichert, gültig bis 01.01.2030.");
  // Den Dateinamen zeigt schon die Dateiauswahl; „Entfernen“ gibt es erst, wenn das Zertifikat gespeichert ist
  await expect(cert.getByRole("button", { name: "Entfernen" })).toBeVisible();
  await expect(cert.getByText("test.pfx").first()).toBeVisible();
  await expect(cert.getByText("gültig bis 01.01.2030", { exact: true })).toBeVisible();
  await expect(cert.getByLabel("Zertifikats-PIN (optional)")).toHaveValue("");
  const formate = page.getByRole("group", { name: "Formate prüfen" });
  await formate.getByRole("button", { name: "Formate mit ERiC prüfen" }).click();
  await expect(formate.getByRole("status")).toHaveText("Alle 8 Nachrichten sind gültig (simuliert, ohne ERiC).");

  // Der Testabruf des Postfachs liefert einen Bescheid; unter der Tabelle steht, was „Einspruch bis“ heißt
  await go("/finanzamt");
  const postfach = page.getByRole("form", { name: "Postfach abrufen" });
  await postfach.getByLabel("Zertifikats-PIN").fill("123456");
  await postfach.getByRole("button", { name: "Testweise abrufen" }).click();
  const bescheide = page.getByRole("region", { name: "Bescheide aus dem ELSTER-Postfach" });
  await expect(bescheide.getByRole("columnheader", { name: "Einspruch bis" })).toBeVisible();
  await expect(bescheide.getByText("Bis zum Datum unter „Einspruch bis“ kannst du Einspruch einlegen.")).toBeVisible();

  // Ohne ERiC läuft der Abruf simuliert und liefert Beispielbelege
  await go(`/jahreserklaerung/${YEAR - 1}`);
  const vast = page.getByRole("region", { name: `Belege von ELSTER ${YEAR - 1}` });
  // Ohne Zertifikat sperrt der Abruf; der Status steht deshalb in der Karte über PIN und Knopf (DESIGN.md, Gesperrte Knöpfe)
  await expect(vast.getByText("Zertifikat hinterlegt", { exact: true })).toBeVisible();
  await vast.getByLabel("Zertifikats-PIN").fill("123456");
  await vast.getByRole("button", { name: "Testweise abrufen" }).click();
  await expect(vast.getByRole("status")).toContainText("2 Belege bei ELSTER, 2 neu gespeichert.");
  await vast.getByText("Rentenbezugsmitteilung").click();
  await expect(vast.getByRole("cell", { name: "1.200,00 €" })).toBeVisible();

  // Berechtigung für die Belege des Ehegatten: beantragen und mit dem Code aus dem Brief freischalten
  await vast.getByLabel("Für").selectOption({ label: "Erika Mustermann" });
  const berechtigung = vast.getByRole("group", { name: "Berechtigung für Erika" });
  await expect(berechtigung).toContainText("noch keine (Test)");
  await vast.getByLabel("Zertifikats-PIN").fill("123456");
  await berechtigung.getByRole("button", { name: "Berechtigung beantragen" }).click();
  await expect(vast.getByRole("status")).toContainText("Erika bekommt von ELSTER einen Brief");
  await expect(berechtigung).toContainText("beantragt, wartet auf Freischaltung");
  // Ohne PIN und Code: Freischalten nennt zuerst die PIN im Formular darüber, dann den Code (DESIGN.md, Gesperrte Knöpfe)
  await berechtigung.getByRole("button", { name: "Freischalten" }).click();
  await expect(vast.getByLabel("Zertifikats-PIN")).toBeFocused();
  await expect(vast.getByLabel("Zertifikats-PIN")).toHaveAccessibleDescription("Trag die PIN des Zertifikats ein.");
  await vast.getByLabel("Zertifikats-PIN").fill("123456");
  await berechtigung.getByRole("button", { name: "Freischalten" }).click();
  await expect(berechtigung.getByLabel("Freischaltcode aus dem Brief")).toBeFocused();
  await expect(berechtigung.getByLabel("Freischaltcode aus dem Brief")).toHaveAccessibleDescription("Trag den Freischaltcode aus dem Brief ein.");
  await berechtigung.getByLabel("Freischaltcode aus dem Brief").fill("ABCD-EFGH-1234");
  await berechtigung.getByRole("button", { name: "Freischalten" }).click();
  await expect(berechtigung).toContainText("genehmigt");
});

test("Keine Fehler im Browser", async () => {
  expect(pageErrors).toEqual([]);
});

test("Abzug für die Abschnitte sichern", async () => {
  await abzugSichern("belege-steuern", page.context());
});
