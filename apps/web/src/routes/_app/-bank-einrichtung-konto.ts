/*
 * Auswahl „Konto in Haben“ der Einrichtung mit Datei (#2008), ohne Serverfunktionen, damit Tests sie laden können.
 */

/** Was der Schritt „Konto“ festlegt; `kontoId` null: Haben legt ein neues an */
export type KontoWahl = { name: string; marketplace: string; kontoId: string | null };

type Konto = { id: string; name: string; provider: string | null; marketplace: string | null };

/**
 * Konten des Anbieters, in die eine Datei gehen darf: nicht die, in die ein Abruf in Haben schreibt (Verbindung oder
 * Etsy) oder die eine externe Quelle haben, solange ein Dateiimport dort Umsätze doppelt anlegen könnte (#1988)
 */
export function vorhandeneKonten(
  daten: { alleKonten: readonly Konto[]; verbindungen: readonly { bankAccountId: string | null }[]; abgerufeneKonten: readonly string[] },
  provider: string,
): Konto[] {
  const abgerufen = new Set<string | null>([...daten.verbindungen.map((v) => v.bankAccountId), ...daten.abgerufeneKonten]);
  return daten.alleKonten.filter((k) => k.provider === provider && !abgerufen.has(k.id));
}

/** Wahl im Feld „Konto in Haben“: ein bestehendes bringt seinen Namen mit, „Neues Konto“ den Vorschlag des Anbieters */
export function kontoWaehlen(wahl: KontoWahl, konten: readonly Konto[], id: string, vorschlag: string): KontoWahl {
  const konto = konten.find((k) => k.id === id);
  return konto ? { ...wahl, kontoId: konto.id, name: konto.name } : { ...wahl, kontoId: null, name: vorschlag };
}
