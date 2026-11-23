import { amountError, parseEuro } from "@haben/core";
import type { FieldErrors } from "../../lib/use-submit-check.ts";

/** Fehler beim Anlegen eines Darlehens (#1270): Name, Restschuld bei Übernahme (leer bei einem neuen Darlehen) und ihr Stichtag */
export function darlehenFehler({
  name,
  restschuld,
  stichtag,
}: {
  name: string;
  restschuld: string;
  stichtag: string;
}): FieldErrors<"name" | "restschuld" | "stichtag"> {
  const cents = restschuld.trim() === "" ? 0 : parseEuro(restschuld);
  return {
    name: name.trim() ? null : "Trag einen Namen für das Darlehen ein, etwa „Hausbank Investitionskredit“.",
    // Der Server nimmt keine negative Restschuld an und zu einer Restschuld nur mit Stichtag (bank/darlehen.ts)
    restschuld: cents !== null && cents >= 0 ? null : amountError("die Restschuld", 2_500_000, { optional: true }),
    stichtag: cents !== null && cents > 0 && stichtag === "" ? "Wähle den Stichtag der Restschuld." : null,
  };
}
