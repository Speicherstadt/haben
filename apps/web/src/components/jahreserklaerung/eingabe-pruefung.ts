import { amountError, type Cents, formatDecimal, parseEuro } from "@haben/core";
import type { FieldErrors } from "../../lib/use-submit-check.ts";

/** Fehler je Feld der Angaben zur Einkommensteuer; jede Lesefunktion trägt ihren Schlüssel ein, null heißt „stimmt“ */
export type Fehler = FieldErrors<string>;

/** Höchstbetrag eines Felds wie im Schema des Servers (`cents` in `jahreserklaerung/income-tax.ts`) */
export const HOECHSTBETRAG: Cents = 100_000_000_00;
const BEISPIEL: Cents = 123_456;
const UNLESBAR = amountError("den Betrag", BEISPIEL, { optional: true });
const GRENZE = amountError(`einen Betrag von 0 bis ${formatDecimal(HOECHSTBETRAG)}`, BEISPIEL, { optional: true });

/** Ein Betrag, der leer bleiben darf; leer und 0 heißen „nichts“ und werden nicht gespeichert */
export function betragLesen(fehler: Fehler, key: string, text: string): Cents | undefined {
  fehler[key] = null;
  if (!text.trim()) return undefined;
  const cents = parseEuro(text);
  if (cents === null || cents < 0 || cents > HOECHSTBETRAG) {
    fehler[key] = cents === null ? UNLESBAR : GRENZE;
    return undefined;
  }
  return cents || undefined;
}

/** Eine Zahl von `min` bis `max`, ganz oder mit Nachkommastellen (Komma oder Punkt); leer heißt „nichts“ */
export function zahlLesen(
  fehler: Fehler,
  key: string,
  text: string,
  { min, max, meldung, ganz = true }: { min: number; max: number; meldung: string; ganz?: boolean },
): number | undefined {
  fehler[key] = null;
  const t = text.trim();
  if (!t) return undefined;
  const n = (ganz ? /^\d+$/ : /^\d+(?:[.,]\d+)?$/).test(t) ? Number(t.replace(",", ".")) : Number.NaN;
  if (!(n >= min && n <= max)) {
    fehler[key] = meldung;
    return undefined;
  }
  return n;
}
