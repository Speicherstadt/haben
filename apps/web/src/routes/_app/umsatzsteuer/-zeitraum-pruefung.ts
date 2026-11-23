import { amountError } from "@haben/core";
import type { FormEvent } from "react";
import { type FieldErrors, useSubmitCheck } from "../../../lib/use-submit-check.ts";

/**
 * Fehler der von Hand überschriebenen Voranmeldung (#1270): je Kennzahl ein nicht lesbarer Betrag (negative sind erlaubt,
 * etwa wenn Gutschriften überwiegen), dazu die Begründung mit mindestens 10 Zeichen wie im Schema von `saveVatDraft`
 */
export function manuellFehler<K extends string>(parsed: Readonly<Record<K, number | null>>, reason: string): FieldErrors<K | "reason"> {
  const fehler = Object.fromEntries(
    (Object.entries(parsed) as [K, number | null][]).map(([feld, cents]) => [feld, cents === null ? amountError("den Betrag der Kennzahl", 123_456) : null]),
  ) as FieldErrors<K | "reason">;
  fehler.reason =
    reason.trim().length >= 10 ? null : "Begründe die Abweichung mit mindestens 10 Zeichen, etwa „Zahlung vom 30.09. erst im Oktober zugeordnet“.";
  return fehler;
}

/**
 * „Entwurf speichern“ prüft beim Absenden statt gesperrt zu sein (DESIGN.md, Gesperrte Knöpfe): von Hand die Kennzahlen und
 * die Begründung, aus den Buchungen nichts davon (`ohne` alle Schlüssel)
 */
export function usePruefungBeimSpeichern<K extends string>(
  parsed: Readonly<Record<K, number | null>>,
  reason: string,
  mode: "berechnet" | "manuell",
  onSave: (event: FormEvent) => void,
) {
  const pruefung = useSubmitCheck(manuellFehler(parsed, reason));
  const alle = [...Object.keys(parsed), "reason"] as (K | "reason")[];
  const speichern = (event: FormEvent) => {
    event.preventDefault();
    if (pruefung.check(mode === "berechnet" ? alle : [])) onSave(event);
  };
  return { pruefung, speichern };
}
