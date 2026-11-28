import { liquiditaetsVorschau, type Cents, type Horizont, type Vorschau } from "@haben/core";
import { dauerbelegPosten } from "./dauerbelege.ts";
import { kontostaende, type Kontostaende } from "./konten.ts";
import { ladeKontext } from "./kontext.ts";
import { offenePostenPosten } from "./offene-posten.ts";
import { umsatzsteuerPostenLaden } from "./umsatzsteuer.ts";
import { vorauszahlungPosten } from "./vorauszahlungen.ts";
import { wiederkehrendPosten } from "./wiederkehrend.ts";

export interface LiquiditaetsBericht {
  vorschau: Vorschau;
  konten: Kontostaende;
  /** Aus den Firmendaten; null = keine Warnung */
  mindestbestand: Cents | null;
}

/**
 * Liquiditätsvorschau für die Seite Auswertungen › Liquidität (#1381): Kontostände plus offene Posten, künftige Dauerbelege
 * und wiederkehrende Rechnungen, Vorauszahlungen und die Umsatzsteuer der noch nicht abgegebenen Zeiträume. Rechnet nur,
 * bucht nichts. `ueberfaellige: false` lässt überfällige Forderungen weg.
 */
export async function liquiditaetsvorschau(
  heute: string,
  horizont: Horizont,
  { ueberfaellige = true }: { ueberfaellige?: boolean } = {},
): Promise<LiquiditaetsBericht> {
  const k = await ladeKontext(heute, horizont);
  // Nacheinander: jeder Adapter stellt mehrere Abfragen, gleichzeitig belegten sie den Pool
  const konten = await kontostaende(heute);
  const posten = [
    ...(await offenePostenPosten(k, { ueberfaellige })),
    ...(await dauerbelegPosten(k)),
    ...(await wiederkehrendPosten(k)),
    ...(await vorauszahlungPosten(k)),
  ];
  // Die Umsatzsteuer rechnet mit der Steuer der übrigen Posten
  const umsatzsteuer = await umsatzsteuerPostenLaden(k, posten);
  const vorschau = liquiditaetsVorschau({ heute, horizont, start: konten.bestand, posten: [...posten, ...umsatzsteuer] });
  return { vorschau, konten, mindestbestand: k.mindestbestand };
}
