import { amountError, type Cents, parseEuro } from "@haben/core";

/**
 * Bisherige oder gewünschte Vorauszahlung je Quartal (#1270): Die Felder haben keinen eigenen Knopf, der Antrag übernimmt sie
 * sofort. Leer heißt „nicht nennen“; ein nicht lesbarer oder negativer Betrag nennt der Antrag ebenfalls nicht, und das Feld
 * meldet ihn gleich.
 */
export function vorauszahlungBetrag(text: string): { cents: Cents | null; fehler: string | null } {
  if (!text.trim()) return { cents: null, fehler: null };
  const cents = parseEuro(text);
  return cents !== null && cents >= 0
    ? { cents, fehler: null }
    : { cents: null, fehler: amountError("die Vorauszahlung je Quartal", 150_000, { optional: true }) };
}
