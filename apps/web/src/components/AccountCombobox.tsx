import { searchOptions } from "../lib/combobox.ts";
import { Combobox, type ComboboxOption } from "./Combobox.tsx";

export interface AccountOption {
  number: string;
  name: string;
}

/** Konto-Zeile einer manuellen Buchung: Kontenrahmen-Nummer mit Namen, frei wählbar.
 *  Zahlen suchen als Prefix der Nummer, Buchstaben im Namen (Umlaut-tolerant, lib/combobox.ts). */
export function AccountCombobox({
  index,
  value,
  accounts,
  invalid,
  describedBy,
  onInput,
  onPick,
  onBlur,
}: {
  index: number;
  value: string;
  /** Nummer zu Name, alle Konten die Haben kennt (Kontenrahmen + eigene) */
  accounts: Record<string, string>;
  invalid: boolean;
  describedBy?: string | undefined;
  onInput: (text: string) => void;
  onPick: (account: AccountOption) => void;
  onBlur?: () => void;
}) {
  const items = (Object.entries(accounts) as [string, string][]).map(([number, name]) => ({ number, name }));
  const describe = (a: AccountOption): ComboboxOption => ({
    key: a.number,
    // Nummer vor der Bezeichnung wie bei den Kategorien (DESIGN.md, Auswahllisten), ohne eigenes Zeilenlayout
    label: a.name ? `${a.number} · ${a.name}` : a.number,
    selected: a.number === value.trim(),
  });
  return (
    <Combobox<AccountOption>
      label={`Konto Zeile ${index + 1}`}
      placeholder="Konto"
      className="account-combobox"
      value={value}
      onInput={onInput}
      onBlur={onBlur}
      // Namen als Teilstring suchen; Nummern nur berücksichtigen, wenn sie mit der Eingabe beginnen.
      search={() => searchOptions(items, value, (a) => [a.number.startsWith(value.trim()) ? a.number : null, a.name])}
      describe={describe}
      onPick={onPick}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
    />
  );
}
