import { amountError, formatDecimal, KENNZAHL_GRENZE } from "@haben/core";
import type { FormEvent } from "react";
import { type FieldErrors, useSubmitCheck } from "../../../lib/use-submit-check.ts";

const NICHT_LESBAR = amountError("den Betrag der Kennzahl", 123_456);
const ZU_GROSS = amountError(`einen Betrag von ${formatDecimal(-KENNZAHL_GRENZE)} bis ${formatDecimal(KENNZAHL_GRENZE)}`, 123_456);
const NICHT_NEGATIV = amountError(`einen Betrag von ${formatDecimal(0)} bis ${formatDecimal(KENNZAHL_GRENZE)}`, 123_456);

function kennzahlFehler(feld: string, cents: number | null): string | null {
  if (cents === null) return NICHT_LESBAR;
  // Kz 50 ist im ERiC-Schema nie negativ (GanzzahlNichtNeg), wie in `saveVatDraft` (#1267)
  if (feld === "kz50") return cents < 0 || cents > KENNZAHL_GRENZE ? NICHT_NEGATIV : null;
  return Math.abs(cents) > KENNZAHL_GRENZE ? ZU_GROSS : null;
}

/**
 * Fehler der von Hand überschriebenen Voranmeldung (#1270): je Kennzahl ein nicht lesbarer Betrag oder einer über der Grenze
 * (negative sind erlaubt, etwa wenn Gutschriften überwiegen, außer bei Kz 50), dazu die Begründung mit mindestens 10 Zeichen, beides wie im
 * Schema von `saveVatDraft`
 */
export function manuellFehler<K extends string>(parsed: Readonly<Record<K, number | null>>, reason: string): FieldErrors<K | "reason"> {
  const fehler = Object.fromEntries(
    (Object.entries(parsed) as [K, number | null][]).map(([feld, cents]) => [feld, kennzahlFehler(feld, cents)]),
  ) as FieldErrors<K | "reason">;
  fehler.reason =
    reason.trim().length >= 10 ? null : "Begründe die Abweichung mit mindestens 10 Zeichen, etwa „Zahlung vom 30.09. erst im Oktober zugeordnet“.";
  return fehler;
}

/**
 * „Entwurf speichern“ und „Nur prüfen“ oder „Senden“ im ELSTER-Kasten prüfen beim Druck statt gesperrt zu sein (DESIGN.md,
 * Gesperrte Knöpfe): von Hand die Kennzahlen und die Begründung, aus den Buchungen nichts davon (`ohne` alle Schlüssel)
 */
export function usePruefungBeimSpeichern<K extends string>(
  parsed: Readonly<Record<K, number | null>>,
  reason: string,
  mode: "berechnet" | "manuell",
  onSave: (event: FormEvent) => void,
) {
  const pruefung = useSubmitCheck(manuellFehler(parsed, reason));
  const alle = [...Object.keys(parsed), "reason"] as (K | "reason")[];
  const check = () => pruefung.check(mode === "berechnet" ? alle : []);
  const speichern = (event: FormEvent) => {
    event.preventDefault();
    if (check()) onSave(event);
  };
  return { pruefung, check, speichern };
}
