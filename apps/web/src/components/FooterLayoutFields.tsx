import type { FooterAlign, LegalPosition, PflichtangabenStelle } from "@haben/core";
import { type layoutHint, LayoutHintText, layoutHintId } from "./LayoutHint.tsx";
import { Segmented } from "./Segmented.tsx";

/** Wo der Fuß was setzt: Ausrichtung der Spalten (#2046) und Stelle der Registerangaben (#1651), Teile der FooterCard */

const LEGAL_OPTIONS: { value: LegalPosition; label: string; name: string }[] = [
  { value: "layout", label: "Wie im Layout", name: "Wie im Layout: Klassisch als Zeile darunter, die anderen als Spalte" },
  { value: "spalte", label: "Als Spalte", name: "Als eigene Spalte neben den übrigen" },
  { value: "zeile", label: "Als Zeile darunter", name: "Als Zeile unter den Spalten" },
];

const ALIGN_OPTIONS: { value: FooterAlign; label: string; name: string }[] = [
  { value: "oben", label: "Oben", name: "Oben bündig: Die ersten Zeilen stehen auf einer Linie" },
  { value: "unten", label: "Unten", name: "Unten bündig: Die letzten Zeilen stehen auf einer Linie" },
];

/** Spalten oben oder unten bündig (#2046); aus, wenn jedes Layout den Fuß in die Randspalte setzt: Dort stehen sie untereinander */
export function FooterAlignField({
  align,
  onChange,
  stellen,
  hint,
}: {
  align: FooterAlign;
  onChange: (align: FooterAlign) => void;
  stellen: readonly PflichtangabenStelle[];
  hint: ReturnType<typeof layoutHint>;
}) {
  const nurRand = stellen.length > 0 && stellen.every((s) => s === "rand");
  const randHinweis = nurRand
    ? "Wirkt nicht in der Randspalte: Dort stehen die Spalten untereinander."
    : stellen.includes("rand")
      ? "In der Randspalte von Elegant und Atelier stehen die Spalten untereinander."
      : null;
  return (
    <div>
      <h3>Spalten ausrichten</h3>
      <Segmented
        label="Ausrichtung der Spalten"
        options={ALIGN_OPTIONS}
        value={align}
        onChange={onChange}
        disabled={nurRand || hint?.aus}
        describedBy={[randHinweis ? "footer-align-hint" : undefined, layoutHintId("footerAlign", hint)].filter(Boolean).join(" ") || undefined}
      />
      {randHinweis && (
        <p id="footer-align-hint" className="field-hint footer-legal-hint">
          {randHinweis}
        </p>
      )}
      <LayoutHintText option="footerAlign" hint={hint} />
    </div>
  );
}

/** Stelle der Registerangaben; aus, wenn ihre Platzhalter in der Fußzeile stehen oder jedes Layout sie in die Randspalte setzt */
export function LegalPositionField({
  position,
  onChange,
  stellen,
  inFooter,
  own,
  hint,
}: {
  position: LegalPosition;
  onChange: (position: LegalPosition) => void;
  stellen: readonly PflichtangabenStelle[];
  inFooter: boolean;
  own: boolean;
  hint: ReturnType<typeof layoutHint>;
}) {
  const nurRand = stellen.length > 0 && stellen.every((s) => s === "rand");
  return (
    <div>
      <h3>Registerangaben</h3>
      <Segmented
        label="Stelle der Registerangaben"
        options={LEGAL_OPTIONS}
        value={position}
        onChange={onChange}
        disabled={inFooter || nurRand || hint?.aus}
        describedBy={["footer-legal-hint", layoutHintId("legalPosition", hint)].filter(Boolean).join(" ")}
      />
      <p id="footer-legal-hint" className="field-hint footer-legal-hint">
        {inFooter
          ? "Steht in deiner Fußzeile: Wo die Platzhalter stehen, stehen auch die Angaben."
          : nurRand
            ? "Wirkt nicht in der Randspalte: Dort stehen die Angaben unter den übrigen."
            : own
              ? "Ohne ihre Platzhalter in der Fußzeile setzt Haben die Registerangaben (§ 35a GmbHG) selbst; mit einem davon brauchst du alle."
              : "Sitz, Registergericht und Nummer, Geschäftsführung (§ 35a GmbHG)."}
        {!inFooter && !nurRand && stellen.includes("rand") && " In der Randspalte von Elegant und Atelier stehen sie immer unter den übrigen Angaben."}
      </p>
      <LayoutHintText option="legalPosition" hint={hint} />
    </div>
  );
}
