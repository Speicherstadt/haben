import { POSITIONS_FELDER, type PositionsFeld } from "../lib/editor-lines.ts";

// Fehler je Feld einer Position im Rechnungseditor und in der wiederkehrenden Rechnung (#1277)

/** Fehler eines Felds der Position, zu sehen erst nach dem ersten Druck auf den Knopf (useSubmitCheck) */
export type PositionsMeldung = (feld: PositionsFeld) => string | undefined;

const meldungsId = (key: number, feld: PositionsFeld) => `pos-fehler-${key}-${feld}`;

/**
 * aria-Attribute einer Zelle: Die Zellen stehen ohne `Field` (DESIGN.md, Felder), tragen bei ihrem Fehler also selbst
 * `aria-invalid` und zeigen per `aria-describedby` auf ihre Meldung (DESIGN.md, Gesperrte Knöpfe). `markiert` färbt die
 * Zelle schon vor der Meldung, im Rechnungseditor, sobald die Position verlassen wurde.
 */
export function zellenAttribute(meldung: PositionsMeldung, key: number, feld: PositionsFeld, markiert = false) {
  const text = meldung(feld);
  return { "aria-invalid": text !== undefined || markiert ? true : undefined, "aria-describedby": text ? meldungsId(key, feld) : undefined };
}

/**
 * Die Meldungen der Position untereinander unter der Zeile, in der Reihenfolge der Zellen. Unter einer Zelle wären sie am
 * Desktop in der schmalen Spalte umgebrochen und schöben die Zeile auseinander; jede nennt deshalb ihr Feld.
 */
export function PositionsMeldungen({ meldung, lineKey }: { meldung: PositionsMeldung; lineKey: number }) {
  const texte = POSITIONS_FELDER.flatMap((feld) => {
    const text = meldung(feld);
    return text ? [{ feld, text }] : [];
  });
  if (texte.length === 0) return null;
  return (
    <div className="line-errors">
      {texte.map(({ feld, text }) => (
        <span key={feld} id={meldungsId(lineKey, feld)} className="field-error">
          {text}
        </span>
      ))}
    </div>
  );
}
