/*
 * Kennung und Version der Einstellungsdatei (#488), ohne Datenbank, damit felder.test.ts sie liest. Die Version steigt,
 * wenn eine ältere Instanz die neue Datei nicht mehr richtig übernähme, etwa weil ein Feld dazukommt, das sie still
 * verwürfe; der Import muss Dateien älterer Versionen weiter lesen.
 */
export const SETTINGS_EXPORT_FORMAT = "haben-einstellungen";
// 2: Artikel mit arbeitskosten (§ 35a EStG, #712). Eine Datei der Version 1 liest der Import weiter, ihre Artikel
// bekommen false (articleInputSchema).
export const SETTINGS_EXPORT_VERSION = 2;
