/*
 * Vollständigkeit (#1635): was in einem Zeitraum noch offen ist und wie weit die Umsätze der Konten reichen, für die
 * Vorprüfung der Voranmeldung und die BWA; später auch für Liquidität, Vollständigkeitsampel, Export und MCP.
 *
 * Öffentliche Schnittstelle des Moduls: Andere Module, Server Functions und Routen importieren nur von hier
 * (Modulgrenzen, scripts/modulgrenzen/regel.ts).
 */
export { kontoAbdeckung, offeneVorgaenge } from "./offen.ts";
