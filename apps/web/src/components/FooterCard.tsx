import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useLayoutEffect, useRef, useState } from "react";
import {
  customFooterRuns,
  DEFAULT_FOOTER_COLUMNS,
  FOOTER_PLACEHOLDERS,
  footerIssues,
  footerValues,
  isKapitalgesellschaft,
  LEGAL_PLACEHOLDERS,
  legalAsColumn,
  legalFooterIssues,
  legalInFooter,
  legalInfo,
  legalStellen,
  MAX_FOOTER_COLUMNS,
  MAX_FOOTER_TEXT,
  MIN_FOOTER_COLUMNS,
  type FooterPlaceholder,
  type FormattedTextRun,
  type LegalInfoSource,
  type LegalPosition,
  type LetterheadDesign,
  type PflichtangabenStelle,
} from "@haben/core";
import { useAction } from "../lib/use-action.ts";
import { saveLetterheadDesign } from "../server/functions/logo.ts";
import { Segmented } from "./Segmented.tsx";
import { FormattedRuns } from "./FormattedText.tsx";
import { FormattedTextarea } from "./FormattedTextarea.tsx";
import { layoutHint, LayoutHintText, layoutHintId, type LayoutHints } from "./LayoutHint.tsx";
import { NoticeBanner } from "./NoticeBanner.tsx";
import { Field } from "./Field.tsx";

const COUNT_OPTIONS = Array.from({ length: MAX_FOOTER_COLUMNS - MIN_FOOTER_COLUMNS + 1 }, (_, i) => {
  const count = String(MIN_FOOTER_COLUMNS + i);
  return { value: count, label: count, name: `${count} Spalten` };
});

const LEGAL_OPTIONS: { value: LegalPosition; label: string; name: string }[] = [
  { value: "layout", label: "Wie im Layout", name: "Wie im Layout: Klassisch als Zeile darunter, die anderen als Spalte" },
  { value: "spalte", label: "Als Spalte", name: "Als eigene Spalte neben den übrigen" },
  { value: "zeile", label: "Als Zeile darunter", name: "Als Zeile unter den Spalten" },
];

type FooterSeller = Parameters<typeof footerValues>[0] & LegalInfoSource;

/** Automatische Fußzeile und Registerangaben je Angabe, wie Haben sie setzt (getFooterPreview) */
export interface FooterPreview {
  automatic: string[][];
  legal: string[];
}

/** Werte der Platzhalter wie auf dem Blatt: IBAN in Vierergruppen (formatIban in packages/einvoice) */
function previewValues(seller: FooterSeller, info: ReturnType<typeof legalInfo>) {
  const filled = footerValues({ ...seller, ...(info ? { legalInfo: info } : {}) });
  return { ...filled, iban: filled.iban.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ") };
}

/** Die Vorschau zeigt die Rechnung; ihr Layout bestimmt die Stelle. Ein eigenes Layout setzt sie selbst, gezeigt wie gewählt */
const previewStelle = (design: LetterheadDesign, stellen: readonly PflichtangabenStelle[], position: LegalPosition): PflichtangabenStelle =>
  design.layouts.rechnung.kind === "eingebaut" ? (stellen[0] ?? "spalte") : position === "spalte" ? "spalte" : "zeile";

const plain = (lines: readonly string[]): FormattedTextRun[][] => lines.map((text) => [{ text, bold: false, italic: false, underline: false }]);

/**
 * Fußzeile der Belege: automatisch aus den Firmendaten oder eigene Spalten mit Platzhaltern; bei GmbH und UG dazu die Stelle
 * der Registerangaben (#1651). Die Vorschau zeigt sie, wie sie auf der Rechnung stehen.
 */
export function FooterCard({
  design,
  seller,
  hidden,
  preview,
  hints,
}: {
  design: LetterheadDesign;
  seller: FooterSeller;
  hidden: boolean;
  preview: FooterPreview;
  hints?: LayoutHints | undefined;
}) {
  const save = useServerFn(saveLetterheadDesign);
  const router = useRouter();
  const { busy, notice, run } = useAction();
  const columns = design.footerColumns;
  const [own, setOwn] = useState(design.footerCustom);
  const [texts, setTexts] = useState<string[]>(columns ?? [...DEFAULT_FOOTER_COLUMNS]);
  const [count, setCount] = useState((columns ?? DEFAULT_FOOTER_COLUMNS).length);
  const [position, setPosition] = useState(design.legalPosition);
  const [focused, setActive] = useState(0);
  // Neuer Stand vom Server: übernehmen, ohne die Karte zu ersetzen, sonst verschwände die Meldung „gespeichert“ mit ihr
  const loaded = JSON.stringify([columns, design.footerCustom, design.legalPosition]);
  const [seen, setSeen] = useState(loaded);
  if (loaded !== seen) {
    setSeen(loaded);
    setOwn(design.footerCustom);
    setTexts(columns ?? [...DEFAULT_FOOTER_COLUMNS]);
    setCount((columns ?? DEFAULT_FOOTER_COLUMNS).length);
    setPosition(design.legalPosition);
  }

  // Weniger Spalten behalten den Text der übrigen: Wer zurückschaltet, verliert nichts
  const shown = Array.from({ length: count }, (_, i) => texts[i] ?? "");
  // Nach dem Verringern kann die zuletzt fokussierte Spalte verborgen sein
  const active = Math.min(focused, count - 1);
  const kapitalgesellschaft = isKapitalgesellschaft(seller.rechtsform);
  // Registerangaben hat heute jede Rechtsform außer dem Einzelunternehmen (legalInfo); nur dann gibt es ihre Einstellung
  const info = legalInfo(seller);
  const withPosition = { ...design, legalPosition: position };
  const issues = own ? [...footerIssues(shown), ...legalFooterIssues(shown, { kapitalgesellschaft, legalAsColumn: legalAsColumn(withPosition) })] : [];
  const inFooter = own && legalInFooter(shown);
  const values = previewValues(seller, info);
  const noBank = own && !shown.some((text) => text.includes("{iban}"));
  const stellen = legalStellen(withPosition);
  const edit = (index: number, text: string) =>
    setTexts(Array.from({ length: Math.max(texts.length, index + 1) }, (_, i) => (i === index ? text : (texts[i] ?? ""))));

  const { fields, touched, insert } = usePlaceholderInsert(shown, active, edit);
  const placeholders = info ? FOOTER_PLACEHOLDERS : FOOTER_PLACEHOLDERS.filter((name) => !(LEGAL_PLACEHOLDERS as readonly string[]).includes(name));

  const onSave = () =>
    run(async () => {
      // Ausgeschaltet bleiben die Spalten gespeichert und kommen beim Einschalten wieder
      await save({ data: { footerCustom: own, ...(own ? { footerColumns: shown } : {}), ...(info ? { legalPosition: position } : {}) } });
      await router.invalidate();
    }, "Fußzeile gespeichert. Sie gilt für alle Belege, die ab jetzt festgeschrieben werden.");

  return (
    <section className="card design-card" aria-labelledby="footer-heading">
      <h2 id="footer-heading">Fußzeile</h2>
      {hidden && (
        <div className="banner banner-info" role="status">
          Ausgeschaltet: Die Fußzeile steht auf dem Briefpapier. Was du hier einstellst, gilt erst wieder, wenn du das unter „Briefpapier“ änderst.
        </div>
      )}
      <div className="checkbox-hinted">
        <label className="checkbox">
          <input type="checkbox" checked={own} onChange={(event) => setOwn(event.target.checked)} aria-describedby={own ? undefined : "footer-own-hint"} />
          Eigene Fußzeile
        </label>
        {!own && (
          <span id="footer-own-hint" className="field-hint">
            Haben setzt die Fußzeile aus den Firmendaten zusammen: Kontakt, Bank, Steuernummern
            {info && " und die Registerangaben der Gesellschaft"}.
          </span>
        )}
      </div>
      {own && (
        <>
          <div>
            <h3>Anzahl Spalten</h3>
            <Segmented label="Anzahl der Spalten" options={COUNT_OPTIONS} value={String(count)} onChange={(value) => setCount(Number(value))} />
          </div>
          <div className="footer-columns" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
            {shown.map((text, index) => (
              <Field key={index} label={`Spalte ${index + 1}`}>
                {(control) => (
                  <FormattedTextarea
                    {...control}
                    fieldRef={(element) => {
                      fields.current[index] = element;
                    }}
                    className="mono autogrow"
                    rows={5}
                    maxLength={MAX_FOOTER_TEXT}
                    value={text}
                    onFocus={(event) => {
                      setActive(index);
                      touched.current.add(event.currentTarget);
                    }}
                    onChange={(event) => edit(index, event.target.value)}
                  />
                )}
              </Field>
            ))}
          </div>
          <div className="footer-chips" role="group" aria-label="Platzhalter einfügen">
            <span className="small muted">Einfügen in Spalte {active + 1}:</span>
            {placeholders.map((placeholder) => (
              <button
                key={placeholder}
                type="button"
                className="btn btn-sm mono"
                // Der Fokus bleibt im Feld, sonst wäre die Stelle im Text weg
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert(placeholder)}
              >
                {`{${placeholder}}`}
              </button>
            ))}
          </div>
          <FooterIssues issues={issues} noBank={noBank} />
        </>
      )}
      {info && (
        <LegalPositionField
          position={position}
          onChange={setPosition}
          stellen={stellen}
          inFooter={inFooter}
          own={own}
          hint={layoutHint(hints, "legalPosition")}
        />
      )}
      <div>
        <h3>So steht sie auf dem Blatt</h3>
        <FooterSheetPreview
          columns={own ? customFooterRuns(shown, values) : preview.automatic.map(plain)}
          legal={info && !inFooter ? preview.legal : []}
          stelle={previewStelle(design, stellen, position)}
        />
      </div>
      <div className="actions">
        <button type="button" className="btn" disabled={busy || issues.length > 0} onClick={() => void onSave()}>
          Fußzeile speichern
        </button>
      </div>
      <NoticeBanner notice={notice} />
    </section>
  );
}

/** Warum sich die Fußzeile nicht speichern lässt, und der Hinweis ohne Bankverbindung */
function FooterIssues({ issues, noBank }: { issues: readonly string[]; noBank: boolean }) {
  return (
    <>
      {issues.map((issue) => (
        <div key={issue} className="banner banner-danger" role="alert">
          {issue}
        </div>
      ))}
      {noBank && (
        <div className="banner banner-warn" role="status">
          Ohne {"{iban}"} steht die Bankverbindung nicht auf dem Blatt.
        </div>
      )}
    </>
  );
}

/** Stelle der Registerangaben; aus, wenn ihre Platzhalter in der Fußzeile stehen oder jedes Layout sie in die Randspalte setzt */
function LegalPositionField({
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

/** Spalten des Fußes und die Registerangaben an ihrer Stelle: als weitere Spalte, als Zeile darunter oder untereinander in der Randspalte */
function FooterSheetPreview({ columns, legal, stelle }: { columns: FormattedTextRun[][][]; legal: string[]; stelle: PflichtangabenStelle }) {
  const asColumn = legal.length > 0 && stelle !== "zeile";
  const all = asColumn ? [...columns, plain(legal)] : columns;
  return (
    <div className="footer-preview" data-stelle={stelle}>
      <div className="footer-columns" style={stelle === "rand" ? undefined : { gridTemplateColumns: `repeat(${all.length}, minmax(0, 1fr))` }}>
        {all.map((lines, index) => (
          <div key={index}>
            {lines.map((runs, i) => (
              <div key={i}>
                <FormattedRuns runs={runs} />
              </div>
            ))}
          </div>
        ))}
      </div>
      {legal.length > 0 && stelle === "zeile" && <p className="footer-preview-legal">{legal.join(" · ")}</p>}
    </div>
  );
}

/**
 * Platzhalter an der Schreibmarke der aktiven Spalte einfügen. React setzt die Schreibmarke beim neuen Wert ans Ende;
 * der nächste Platzhalter gehört aber hinter den vorigen, darum setzt sie der Effekt danach zurück.
 */
function usePlaceholderInsert(shown: string[], active: number, edit: (index: number, text: string) => void) {
  const fields = useRef<(HTMLTextAreaElement | null)[]>([]);
  const caret = useRef<number | null>(null);
  // Je Feld, nicht je Spalte: Ein neu eingeblendetes Feld steht mit der Schreibmarke wieder auf 0
  const touched = useRef(new WeakSet<HTMLTextAreaElement>());

  const insert = (placeholder: FooterPlaceholder) => {
    const field = fields.current[active];
    const text = shown[active] ?? "";
    // Noch nie im Feld gewesen: Die Schreibmarke steht auf 0, der Platzhalter gehört aber hinter den vorhandenen Text
    const used = field && touched.current.has(field);
    const at = used ? field.selectionStart : text.length;
    const end = used ? field.selectionEnd : at;
    const tag = `{${placeholder}}`;
    edit(active, `${text.slice(0, at)}${tag}${text.slice(end)}`);
    if (field) touched.current.add(field);
    caret.current = at + tag.length;
    field?.focus();
  };

  useLayoutEffect(() => {
    if (caret.current === null) return;
    fields.current[active]?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  return { fields, touched, insert };
}
