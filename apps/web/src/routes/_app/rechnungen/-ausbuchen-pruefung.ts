import { amountError, type Cents, parseEuro } from "@haben/core";
import type { FieldErrors } from "../../../lib/use-submit-check.ts";

/** Fehler beim Ausbuchen des Rests einer Rechnung (#1270): Betrag über 0 bis zum offenen Rest, Datum */
export function ausbuchenFehler({ betrag, offen, datum }: { betrag: string; offen: Cents; datum: string }): FieldErrors<"betrag" | "datum"> {
  const cents = parseEuro(betrag);
  return {
    betrag: cents !== null && cents > 0 && cents <= offen ? null : amountError("einen Betrag über 0 bis zum offenen Rest", offen),
    datum: datum ? null : "Wähle den Tag der Ausbuchung.",
  };
}
