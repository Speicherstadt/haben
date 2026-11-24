import { gruppierteIban } from "@haben/core";
import { Field } from "./Field.tsx";

/** Weitere Bankverbindung zur Auswahl in Rechnung, Angebot und Kontakt (#1887) */
export interface BankverbindungOption {
  id: string;
  bezeichnung: string;
  iban: string;
  archivedAt: Date | string | null;
}

/**
 * Auswahl der Bankverbindung; steht nur da, wenn es weitere gibt (Einstellungen › Firma). Leer = Standard aus den
 * Firmendaten. Eine schon gewählte, inzwischen archivierte bleibt in der Liste, neu wählbar sind nur aktive.
 */
export function BankverbindungField({
  bankverbindungen,
  standardIban,
  value,
  disabled,
  hint,
  name,
  onChange,
}: {
  bankverbindungen: readonly BankverbindungOption[];
  standardIban: string;
  value: string;
  disabled: boolean;
  hint: string;
  /** Im Formular, das über FormData speichert (Kontakt) */
  name?: string;
  onChange: (id: string) => void;
}) {
  const choices = bankverbindungen.filter((b) => !b.archivedAt || b.id === value);
  if (choices.length === 0) return null;
  return (
    <Field label="Bankverbindung" hint={hint} style={{ gridColumn: "1 / -1" }}>
      {(control) => (
        <select {...control} name={name} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">Standard{standardIban ? ` · ${gruppierteIban(standardIban)}` : ""}</option>
          {choices.map((b) => (
            <option key={b.id} value={b.id}>
              {b.bezeichnung} · {gruppierteIban(b.iban)}
              {b.archivedAt ? " (archiviert)" : ""}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
