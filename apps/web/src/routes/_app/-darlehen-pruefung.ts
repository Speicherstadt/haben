import { amountError, parseEuro } from "@haben/core";
import type { FieldErrors } from "../../lib/use-submit-check.ts";

/** Fehler beim Anlegen eines Darlehens (#1270): Name und Restschuld bei Übernahme, leer bei einem neuen Darlehen */
export function darlehenFehler({ name, restschuld }: { name: string; restschuld: string }): FieldErrors<"name" | "restschuld"> {
  const cents = restschuld.trim() === "" ? 0 : parseEuro(restschuld);
  return {
    name: name.trim() ? null : "Trag einen Namen für das Darlehen ein, etwa „Hausbank Investitionskredit“.",
    // Der Server nimmt keine negative Restschuld an (bank/darlehen.ts)
    restschuld: cents !== null && cents >= 0 ? null : amountError("die Restschuld", 2_500_000, { optional: true }),
  };
}
