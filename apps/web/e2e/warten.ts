import { expect, type Page, type Request } from "@playwright/test";

/*
 * Warten auf Ereignisse statt auf feste Zeit (docs/entwicklung.md, Tests). Für Prüfungen, dass etwas nicht passiert:
 * erst abwarten, was es auslösen würde, dann sofort prüfen.
 */

/**
 * Wartet, bis die Seite abgearbeitet hat, was bis jetzt angestoßen ist: einige Runden über MessageChannel, wo React
 * seine Updates einplant. Geht auch mit `page.clock`, denn MessageChannel verfälscht die Uhr nicht.
 */
export async function abgearbeitet(page: Page, runden = 5): Promise<void> {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) {
      await new Promise<void>((weiter) => {
        const kanal = new MessageChannel();
        kanal.port1.onmessage = () => weiter();
        kanal.port2.postMessage(null);
      });
    }
  }, runden);
}

/** Wartet `anzahl` Bilder ab; Übergänge melden ihren Start (transitionrun) spätestens im Bild nach der Änderung */
export async function bilder(page: Page, anzahl = 2): Promise<void> {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise((weiter) => requestAnimationFrame(weiter));
  }, anzahl);
  await abgearbeitet(page);
}

/**
 * Verfolgt die Aufrufe von Server-Functions ab jetzt; `fertig()` wartet, bis mindestens einer kam und keiner mehr offen
 * ist, und arbeitet danach die Seite ab
 */
export function serverAufrufe(page: Page) {
  const offen = new Set<Request>();
  let gesehen = 0;
  const rein = (anfrage: Request) => {
    if (!new URL(anfrage.url()).pathname.startsWith("/_serverFn/")) return;
    offen.add(anfrage);
    gesehen += 1;
  };
  const raus = (anfrage: Request) => offen.delete(anfrage);
  page.on("request", rein);
  page.on("requestfinished", raus);
  page.on("requestfailed", raus);
  return {
    async fertig(): Promise<void> {
      await expect.poll(() => gesehen > 0 && offen.size === 0).toBe(true);
      page.off("request", rein);
      page.off("requestfinished", raus);
      page.off("requestfailed", raus);
      await abgearbeitet(page);
    },
  };
}
