import { test } from "@playwright/test";
import { abzugEinspielen, abzugSichern } from "./abzug.ts";

/**
 * Zwischen „ablauf“ und „mit-daten“ (playwright.config.ts): sichert den Stand nach app.spec.ts und spielt ihn gleich wieder
 * ein, damit jeder Lauf das Einspielen mitprüft. Mit E2E_ABZUG=1 läuft „ablauf“ nicht, eingespielt wird der Abzug eines
 * früheren Laufs.
 */
test("Abzug der Einrichtung sichern und einspielen", async () => {
  test.setTimeout(180_000);
  if (!process.env.E2E_ABZUG) await abzugSichern();
  await abzugEinspielen();
});
