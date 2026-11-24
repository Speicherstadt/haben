import { z } from "zod";

/*
 * Listen der Werkzeuge blättern wie die REST-API (api/schemas.ts, pageQuery): limit und offset in der Eingabe, total,
 * limit und offset in der Antwort (#1518). Die Liste selbst behält den Namen, den das Werkzeug ihr gibt.
 */

export const limitSchema = z.number().int().min(1).max(200).default(50).describe("Höchstens so viele Einträge (Standard 50)");
export const offsetSchema = z.number().int().min(0).default(0).describe("So viele Einträge überspringen; weiter, bis offset + limit total erreicht");

/** Für Listen, die schon die Abfrage schneidet: `gekuerzt`, solange hinter dieser Seite noch Einträge kommen */
export function fortsetzung(total: number, limit: number, offset: number, laenge: number) {
  return { total, limit, offset, gekuerzt: total > offset + laenge };
}

/** Ausschnitt einer fertig sortierten Liste mit der Zahl aller Treffer */
export function seite<T>(rows: readonly T[], limit: number, offset: number) {
  return { total: rows.length, limit, offset, eintraege: rows.slice(offset, offset + limit) };
}
