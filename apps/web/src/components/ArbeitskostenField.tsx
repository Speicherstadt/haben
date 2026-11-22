import { useId, useState } from "react";

/** Die zwei Werte des Kennzeichens nach § 35a EStG (#712), gleich in Position und Artikel */
export const ARBEITSKOSTEN_OPTIONEN = [
  ["nein", "Material und Sonstiges"],
  ["ja", "Arbeit, Maschinen, Fahrt"],
] as const;

/**
 * Schalter „Anteil ausweisen“ über Positionen mit Kennzeichen arbeitskosten, für Rechnung, Angebot und wiederkehrende
 * Rechnung: an, sobald eine Position das Kennzeichen trägt (auch aus einem Artikel), damit der Satz nie unbemerkt auf dem
 * Blatt steht; aus nimmt es allen Positionen. Haben kennt kein Merkmal „Privatkunde“.
 */
export function useArbeitskostenSchalter<L extends { arbeitskosten: boolean }>(
  lines: L[],
  setLines: (update: (prev: L[]) => L[]) => void,
): [boolean, (on: boolean) => void] {
  const [schalter, setSchalter] = useState(false);
  const an = schalter || lines.some((line) => line.arbeitskosten);
  const setAn = (on: boolean) => {
    setSchalter(on);
    if (!on) setLines((prev) => prev.map((line) => (line.arbeitskosten ? { ...line, arbeitskosten: false } : line)));
  };
  return [an, setAn];
}

export function ArbeitskostenField({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  const hintId = useId();
  return (
    <div className="checkbox-hinted">
      <label className="checkbox">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} aria-describedby={hintId} />
        Anteil der Arbeits-, Maschinen- und Fahrtkosten ausweisen (§ 35a EStG)
      </label>
      <span id={hintId} className="field-hint">
        Für Privatkunden, die Handwerkerleistungen oder haushaltsnahe Dienstleistungen absetzen. Je Position wählst du Material oder Arbeit; die Summe der
        Arbeit steht unter den Summen im PDF und in der E-Rechnung. Artikel bringen ihre Vorgabe mit.
      </span>
    </div>
  );
}

/** Art einer Position für § 35a EStG; steht wie die Art im Angebot hinter der Bezeichnung */
export function LineArbeitskosten({ index, value, onChange }: { index: number; value: boolean; onChange: (value: boolean) => void }) {
  return (
    // biome-ignore lint/plugin: Teil der Positionszeile (`.line-title`) neben der Bezeichnung; aria-label benennt die Auswahl
    <select
      className="line-kind"
      aria-label={`Kosten der Position ${index + 1} für § 35a EStG`}
      value={value ? "ja" : "nein"}
      onChange={(e) => onChange(e.target.value === "ja")}
    >
      {ARBEITSKOSTEN_OPTIONEN.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}
