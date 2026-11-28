import { STANDARD_HORIZONT, unterschreitung, unterschreitungText, type Unterschreitung } from "@haben/core";
import { loadCompany } from "../stammdaten/index.ts";
import { liquiditaetsvorschau } from "./vorschau.ts";

/*
 * Warnung vor dem Mindestbestand (#1381) für Übersicht und Fristen-Mail: dieselbe Vorschau wie die Seite ohne Auswahl
 * (STANDARD_HORIZONT, überfällige Forderungen eingerechnet), damit der Link dorthin denselben Tag zeigt.
 */

/**
 * Erster Tag in den nächsten 13 Wochen unter dem Mindestbestand; null ohne Mindestbestand, ohne bekannten Kontostand (die
 * Vorschau startete bei 0 €, die Seite nennt das fehlende Konto) oder wenn der Stand darüber bleibt
 */
export async function mindestbestandWarnung(heute: string): Promise<Unterschreitung | null> {
  const { mindestbestand } = await loadCompany();
  if (mindestbestand === null) return null;
  const { vorschau, konten } = await liquiditaetsvorschau(heute, STANDARD_HORIZONT);
  return konten.bekannt ? unterschreitung(vorschau, mindestbestand) : null;
}

/** Zeile für die Fristen-Mail mit dem Pfad der Liquiditätsvorschau; null ohne Warnung */
export async function mindestbestandHinweis(heute: string): Promise<{ text: string; link: string } | null> {
  const w = await mindestbestandWarnung(heute);
  if (!w) return null;
  const { titel, detail } = unterschreitungText(w);
  return { text: `${titel}. ${detail}`, link: "/auswertungen/liquiditaet" };
}
