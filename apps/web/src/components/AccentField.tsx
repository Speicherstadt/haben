import { ACCENT_PATTERN, contrastOnWhite, type LetterheadDesignInput, MIN_TEXT_CONTRAST } from "@haben/core";
import { useLoadedState } from "../lib/use-loaded-state.ts";
import { Field } from "./Field.tsx";

/**
 * Vorschläge der Spalte Gestaltung; Schwarz für Belege ganz ohne Farbe, die Grautöne werden dann neutral (#1674). Es ersetzt
 * das frühere Grau #3F4A44, das als Punkt kaum davon zu unterscheiden war; wer es gespeichert hat, sieht es als eigene Farbe
 */
const SWATCHES = [
  { hex: "#1F6F5C", name: "Grün" },
  { hex: "#1D4E89", name: "Blau" },
  { hex: "#6B3FA0", name: "Violett" },
  { hex: "#9B1C1C", name: "Rot" },
  { hex: "#B45309", name: "Orange" },
  { hex: "#000000", name: "Schwarz" },
];

/** Hex-Wert aus der Eingabe, #RRGGBB in Großbuchstaben; ohne # wie aus anderen Programmen kopiert; null, solange er unvollständig ist */
export function hexAusEingabe(text: string): string | null {
  const wert = text.trim();
  const hex = wert.startsWith("#") ? wert : `#${wert}`;
  return ACCENT_PATTERN.test(hex) ? hex.toUpperCase() : null;
}

/** Farbe der Belege in der Spalte Gestaltung: Vorschläge, eigene Farbe per Farbwähler oder Hex-Wert, oder die Farbe des Layouts */
export function AccentField({
  accent,
  fromLayout,
  layoutAccent,
  onChange,
}: {
  accent: string;
  /** Farbe aus dem Layout statt der eigenen */
  fromLayout: boolean;
  layoutAccent?: string | undefined;
  onChange: (input: LetterheadDesignInput) => void;
}) {
  // Nur zur eigenen Farbe: Die Farbe eines Layouts ist dort gesetzt, wo sie sich liest
  const weak = !fromLayout && ACCENT_PATTERN.test(accent) && contrastOnWhite(accent) < MIN_TEXT_CONTRAST;
  const custom = !fromLayout && !SWATCHES.some((swatch) => swatch.hex === accent.toUpperCase());
  const pick = (hex: string) => onChange({ accent: hex, accentFromLayout: false });
  // Das Feld zeigt die Farbe, die auf den Belegen steht: mit „Farbe des Layouts“ die des Layouts, sonst die eigene.
  // Es folgt Klicks auf Vorschläge und Farbwähler; ein halber Wert bleibt stehen, bis er vollständig ist
  const wirksam = fromLayout && layoutAccent ? layoutAccent : accent;
  const [text, setText] = useLoadedState(wirksam);
  const eingabe = (value: string) => {
    setText(value);
    const hex = hexAusEingabe(value);
    // Mit „Farbe des Layouts“ wirkt die gespeicherte eigene Farbe nicht; jede vollständige Eingabe schaltet auf sie um
    if (hex && (fromLayout || hex !== accent.toUpperCase())) pick(hex);
  };
  return (
    <section>
      <h3>Farbe</h3>
      <div className="color-swatches">
        <label className="color-swatch color-swatch-custom" title="Eigene Farbe wählen" data-active={custom || undefined}>
          <span>{custom && <span className="color-swatch-dot" style={{ background: accent }} />}</span>
          <input type="color" aria-label="Eigene Farbe wählen" value={wirksam.toLowerCase()} onChange={(event) => pick(event.target.value.toUpperCase())} />
        </label>
        {SWATCHES.map((swatch) => (
          <button
            key={swatch.hex}
            type="button"
            className="color-swatch"
            aria-label={swatch.name}
            aria-pressed={!fromLayout && accent.toUpperCase() === swatch.hex}
            onClick={() => pick(swatch.hex)}
          >
            <span style={{ background: swatch.hex }} />
          </button>
        ))}
      </div>
      <Field label="Hex-Wert" hint="Form #RRGGBB" error={text.trim() && !hexAusEingabe(text) ? "Unvollständig, etwa #1D4E89" : undefined}>
        {(control) => (
          <input
            {...control}
            className="mono"
            style={{ width: "9em" }}
            value={text}
            onChange={(event) => eingabe(event.target.value)}
            onBlur={() => !hexAusEingabe(text) && setText(wirksam)}
            spellCheck={false}
            autoComplete="off"
          />
        )}
      </Field>
      <label className="checkbox">
        <input type="checkbox" checked={fromLayout} onChange={(event) => onChange({ accentFromLayout: event.target.checked })} />
        Farbe des Layouts
        {layoutAccent && <span className="color-swatch-dot" style={{ background: layoutAccent }} aria-hidden="true" />}
      </label>
      {weak && (
        <div className="banner banner-info" role="status">
          Diese Farbe ist auf weißem Papier schwer zu lesen.
        </div>
      )}
    </section>
  );
}
