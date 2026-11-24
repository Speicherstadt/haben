import { amountError, parseEuro } from "@haben/core";
import type { FieldErrors } from "../../lib/use-submit-check.ts";

/** Höchstbetrag einer Ausschüttung wie im Schema des Servers (`ausschuettungSchema`) */
const HOECHSTBETRAG = 100_000_000_000_00;

/**
 * Fehler beim Berechnen des Steuerabzugs einer Ausschüttung (#1277): je Feld eine Meldung, Grenzen wie der Server. Auszahlungstag
 * vor dem Beschluss und Geschäftsjahr nach dessen Jahr nimmt das Schema an, `ausschuettungVorschlag` sperrt dann das Buchen.
 */
export function ausschuettungFehler({
  beschluss,
  auszahlungstag,
  geschaeftsjahr,
  betrag,
}: {
  beschluss: string;
  auszahlungstag: string;
  geschaeftsjahr: string;
  betrag: string;
}): FieldErrors<"beschluss" | "auszahlungstag" | "geschaeftsjahr" | "betrag"> {
  const jahr = Number(geschaeftsjahr.trim());
  const beschlussjahr = Number(beschluss.slice(0, 4));
  const brutto = parseEuro(betrag);
  const jahrGueltig = /^\d{4}$/.test(geschaeftsjahr.trim()) && jahr >= 1900 && jahr <= 2999;
  return {
    beschluss: beschluss ? null : "Wähle das Datum des Beschlusses.",
    auszahlungstag: auszahlungstag && beschluss && auszahlungstag < beschluss ? "Wähle einen Tag ab dem Beschluss." : null,
    geschaeftsjahr: !jahrGueltig
      ? "Trag das Geschäftsjahr vierstellig ein, etwa 2025."
      : beschluss && jahr > beschlussjahr
        ? `Trag ein Geschäftsjahr bis ${beschlussjahr} ein, etwa ${beschlussjahr - 1}.`
        : null,
    betrag: brutto !== null && brutto > 0 && brutto <= HOECHSTBETRAG ? null : amountError("einen Betrag über 0", 3_000_000),
  };
}
