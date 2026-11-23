import { parseEuro } from "@haben/core";
import type { FieldKey } from "./-zeitraum-kennzahlen.tsx";

/** Fehler je Feld nach dem ersten Speichern (useSubmitCheck) */
type MitFehlern = { fehler: (field: FieldKey) => string | undefined };

/**
 * Die Eingaben der Tabelle stehen ohne `Field` (DESIGN.md, Felder): Bei einem Fehler tragen sie selbst `aria-invalid` und
 * zeigen per `aria-describedby` auf die Meldung, die als letztes Kind der Zeile ab der zweiten Spalte steht (#1270)
 */
export function kzFeld(eingabe: MitFehlern, field: FieldKey, id: string, hint?: string) {
  const fehler = eingabe.fehler(field);
  return { "aria-invalid": fehler ? true : undefined, "aria-describedby": [hint, fehler ? `${id}-fehler` : null].filter(Boolean).join(" ") || undefined };
}

/** Ein nicht lesbarer Betrag zählt in `shown` als 0: Die Zeile bleibt, damit das Feld samt Meldung zu sehen ist (#1270) */
export function kzOffen(eingabe: { editable: boolean; values: Record<FieldKey, string> }, field: FieldKey) {
  return eingabe.editable && parseEuro(eingabe.values[field]) === null;
}

export function KzFehler({ eingabe, field, id }: { eingabe: MitFehlern; field: FieldKey; id: string }) {
  const fehler = eingabe.fehler(field);
  if (!fehler) return null;
  return (
    <span id={`${id}-fehler`} className="field-error" style={{ gridColumn: "2 / -1" }}>
      {fehler}
    </span>
  );
}
