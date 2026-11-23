import type { Cents } from "./money.ts";

/** Was eine Voranmeldung zu Kz 43 und 48 braucht, um frühere Zuordnungen nachzurechnen (VatFigures) */
export interface ZuordnungsQuellen {
  kz43: Cents;
  kz48: Cents;
  /** Darin in Kz 48: Umsätze als Kleinunternehmer (#1268) */
  kz48Kleinunternehmer: Cents;
  /** Kz 43 und 48 vor #1312 (bei Ist mit der Zahlung, Anzahlungen mit ihrer Zahlung), ohne Umsätze als Kleinunternehmer */
  bisher: { kz43: Cents; kz48: Cents };
}

/**
 * Kz 43 und 48, wie frühere Versionen von Haben sie gemeldet haben: vor #1268 ohne Umsätze als Kleinunternehmer, vor
 * #1312 bei Ist mit der Zahlung statt im Zeitraum der Leistung und Anzahlungen mit ihrer Zahlung, und vor beiden.
 * Gesendete Voranmeldungen ändern sich nicht; stimmt eine mit einer dieser Zuordnungen überein, haben sich ihre Buchungen
 * nicht geändert (Abgleich gesendeter Voranmeldungen, Hinweis auf der Seite des Zeitraums).
 */
export function fruehereZuordnungen(f: ZuordnungsQuellen): { kz43: Cents; kz48: Cents }[] {
  const alt = f.bisher;
  return [
    { kz43: f.kz43, kz48: f.kz48 - f.kz48Kleinunternehmer },
    { kz43: alt.kz43, kz48: alt.kz48 + f.kz48Kleinunternehmer },
    { kz43: alt.kz43, kz48: alt.kz48 },
  ];
}
