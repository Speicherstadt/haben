import { amountError, parseEuro } from "@haben/core";
import type { FieldErrors } from "../../lib/use-submit-check.ts";

/** Höchstbetrag einer Ausschüttung wie im Schema des Servers (`ausschuettungSchema`) */
const HOECHSTBETRAG = 100_000_000_000_00;

/** Fehler beim Berechnen des Steuerabzugs einer Ausschüttung (#1277): je Feld eine Meldung, Grenzen wie der Server */
export function ausschuettungFehler({
  beschluss,
  geschaeftsjahr,
  betrag,
}: {
  beschluss: string;
  geschaeftsjahr: string;
  betrag: string;
}): FieldErrors<"beschluss" | "geschaeftsjahr" | "betrag"> {
  const jahr = Number(geschaeftsjahr.trim());
  const brutto = parseEuro(betrag);
  return {
    beschluss: beschluss ? null : "Wähle das Datum des Beschlusses.",
    geschaeftsjahr: /^\d{4}$/.test(geschaeftsjahr.trim()) && jahr >= 1900 && jahr <= 2999 ? null : "Trag das Geschäftsjahr vierstellig ein, etwa 2025.",
    betrag: brutto !== null && brutto > 0 && brutto <= HOECHSTBETRAG ? null : amountError("einen Betrag über 0", 3_000_000),
  };
}
