import { amountError, type Cents, formatDecimal, parseEuro } from "@haben/core";
import type { FieldErrors } from "../../lib/use-submit-check.ts";
import { ZEILENBETRAG_GRENZE } from "../../lib/zeilenwerte.ts";

const BEISPIEL: Cents = 123_456;
const NICHT_LESBAR = amountError("den Betrag der Zeile", BEISPIEL, { optional: true });
// Dieselbe Grenze wie der Server; ohne sie stand dessen Meldung englisch über der Knopfzeile
const ZU_GROSS = amountError(`einen Betrag von ${formatDecimal(-ZEILENBETRAG_GRENZE)} bis ${formatDecimal(ZEILENBETRAG_GRENZE)}`, BEISPIEL, {
  optional: true,
});

/**
 * Die eingetippten Zeilenwerte (#1270): gelesene Zeilen, je Feld ein Fehler für einen nicht lesbaren Wert und die Zahl der
 * ausgefüllten Felder. Leer heißt „nicht speichern“, 0 und negative Beträge bis zur Grenze des Servers sind gültige Zeilen.
 */
export function erklaerteZeilen(
  felder: readonly { field: string }[],
  werte: Readonly<Record<string, string>>,
): { zeilen: { field: string; amount: Cents }[]; fehler: FieldErrors<string>; eingetragen: number } {
  const zeilen: { field: string; amount: Cents }[] = [];
  const fehler: FieldErrors<string> = {};
  let eingetragen = 0;
  for (const { field } of felder) {
    const text = werte[field] ?? "";
    fehler[field] = null;
    if (!text.trim()) continue;
    eingetragen++;
    const cents = parseEuro(text);
    if (cents === null) fehler[field] = NICHT_LESBAR;
    else if (Math.abs(cents) > ZEILENBETRAG_GRENZE) fehler[field] = ZU_GROSS;
    else zeilen.push({ field, amount: cents });
  }
  return { zeilen, fehler, eingetragen };
}
