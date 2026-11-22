/*
 * Kennung und Version der Einstellungsdatei (#488), ohne Datenbank, damit felder.test.ts sie liest. Die Version steigt,
 * wenn eine ältere Instanz die neue Datei nicht mehr richtig übernähme, etwa weil ein Feld dazukommt, das sie still
 * verwürfe; der Import muss Dateien älterer Versionen weiter lesen.
 */
export const SETTINGS_EXPORT_FORMAT = "haben-einstellungen";
// 2: Textbausteine mit „Standard für“, die Standard-Einleitungen sind keine Firmendaten mehr (#1494). Eine Datei der
// Version 1 liest der Import weiter, ihre Einleitungen werden zu Standard-Bausteinen (alteStandardEinleitungen).
// 3: Standard-Textbaustein je Mahnstufe statt „mahnung“ (#1678). Ein Standard „mahnung“ einer älteren Datei gilt danach
// für jede Stufe (alterMahnungsStandard in stammdaten/uebernahme.ts).
export const SETTINGS_EXPORT_VERSION = 3;
