import { amountError, type Cents, parseEuro } from "@haben/core";
import type { FieldErrors } from "../../lib/use-submit-check.ts";

/**
 * Die eingetippten Zeilenwerte (#1270): gelesene Zeilen, je Feld ein Fehler für einen nicht lesbaren Wert und die Zahl der
 * ausgefüllten Felder. Leer heißt „nicht speichern“, 0 und negative Beträge sind gültige Zeilen.
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
    if (cents === null) fehler[field] = amountError("den Betrag der Zeile", 123_456, { optional: true });
    else zeilen.push({ field, amount: cents });
  }
  return { zeilen, fehler, eingetragen };
}
