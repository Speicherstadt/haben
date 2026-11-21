import { useId } from "react";

/**
 * Schalter für den Anteil der Arbeits-, Maschinen- und Fahrtkosten (§ 35a EStG, #712). Haben kennt kein Merkmal
 * „Privatkunde“; wer den Anteil nicht will, schaltet ihn ab, und alle Positionen verlieren ihr Kennzeichen.
 */
export function ArbeitskostenField({ checked, onChange, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  const hintId = useId();
  return (
    <div className="checkbox-hinted">
      <label className="checkbox">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} aria-describedby={hintId} />
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
      <option value="nein">Material und Sonstiges</option>
      <option value="ja">Arbeit, Maschinen, Fahrt</option>
    </select>
  );
}
