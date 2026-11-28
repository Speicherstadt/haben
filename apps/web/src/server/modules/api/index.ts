/*
 * REST-API unter /api/v1 (#199): Kontakte und Rechnungsentwürfe für eigene Werkzeuge und Automationen, mit den
 * API-Tokens aus dem Modul mcp und einer OpenAPI-Beschreibung unter /api/v1/openapi.json. Festschreiben (samt Buchung)
 * und Versenden nur für Entwürfe einer externen Quelle mit dem Recht rechnungen:festschreiben (invoice-finalize.ts, #1918).
 *
 * Öffentliche Schnittstelle des Moduls: Andere Module, Server Functions und Routen importieren nur von hier
 * (Modulgrenzen, scripts/modulgrenzen/regel.ts).
 */
export { openApiDocument } from "./openapi.ts";
export { API_PREFIX, handleApiRequest } from "./router.ts";
