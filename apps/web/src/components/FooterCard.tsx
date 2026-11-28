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
  type FooterAlign,
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
import { FooterAlignField, LegalPositionField } from "./FooterLayoutFields.tsx";
import { FormattedRuns } from "./FormattedText.tsx";
import { FormattedTextarea } from "./FormattedTextarea.tsx";
import { layoutHint, type LayoutHints } from "./LayoutHint.tsx";
import { NoticeBanner } from "./NoticeBanner.tsx";
import { Field } from "./Field.tsx";

const COUNT_OPTIONS = Array.from({ length: MAX_FOOTER_COLUMNS - MIN_FOOTER_COLUMNS + 1 }, (_, i) => {
  const count = String(MIN_FOOTER_COLUMNS + i);
  return { value: count, label: count, name: `${count} Spalten` };
});

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
  const { own, setOwn, texts, setTexts, count, setCount, position, setPosition, align, setAlign } = useFooterDraft(design);
  const [focused, setActive] = useState(0);

  // Weniger Spalten behalten den Text der übrigen: Wer zurückschaltet, verliert nichts
  const shown = Array.from({ length: count }, (_, i) => texts[i] ?? "");
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

  const onSave = () =>
    run(async () => {
      // Ausgeschaltet bleiben die Spalten gespeichert und kommen beim Einschalten wieder
      await save({ data: { footerCustom: own, footerAlign: align, ...(own ? { footerColumns: shown } : {}), ...(info ? { legalPosition: position } : {}) } });
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
          <OwnFooterColumns shown={shown} onCount={setCount} edit={edit} focused={focused} onFocusColumn={setActive} withLegal={Boolean(info)} />
          <FooterIssues issues={issues} noBank={noBank} />
        </>
      )}
      <FooterAlignField align={align} onChange={setAlign} stellen={stellen} hint={layoutHint(hints, "footerAlign")} />
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
          align={align}
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

/** Stand der Karte; ein neuer Stand vom Server wird übernommen, ohne die Karte zu ersetzen, sonst verschwände die Meldung „gespeichert“ mit ihr */
function useFooterDraft(design: LetterheadDesign) {
  const columns = design.footerColumns;
  const [own, setOwn] = useState(design.footerCustom);
  const [texts, setTexts] = useState<string[]>(columns ?? [...DEFAULT_FOOTER_COLUMNS]);
  const [count, setCount] = useState((columns ?? DEFAULT_FOOTER_COLUMNS).length);
  const [position, setPosition] = useState(design.legalPosition);
  const [align, setAlign] = useState(design.footerAlign);
  const loaded = JSON.stringify([columns, design.footerCustom, design.legalPosition, design.footerAlign]);
  const [seen, setSeen] = useState(loaded);
  if (loaded !== seen) {
    setSeen(loaded);
    setOwn(design.footerCustom);
    setTexts(columns ?? [...DEFAULT_FOOTER_COLUMNS]);
    setCount((columns ?? DEFAULT_FOOTER_COLUMNS).length);
    setPosition(design.legalPosition);
    setAlign(design.footerAlign);
  }
  return { own, setOwn, texts, setTexts, count, setCount, position, setPosition, align, setAlign };
}

/** Anzahl und Text der eigenen Spalten, darunter die Platzhalter zum Einfügen in die zuletzt fokussierte Spalte */
function OwnFooterColumns({
  shown,
  onCount,
  edit,
  focused,
  onFocusColumn,
  withLegal,
}: {
  shown: string[];
  onCount: (count: number) => void;
  edit: (index: number, text: string) => void;
  /** Bleibt beim Aus- und Einschalten der eigenen Fußzeile, darum in der Karte */
  focused: number;
  onFocusColumn: (index: number) => void;
  withLegal: boolean;
}) {
  const count = shown.length;
  // Nach dem Verringern kann die zuletzt fokussierte Spalte verborgen sein
  const active = Math.min(focused, count - 1);
  const { fields, touched, insert } = usePlaceholderInsert(shown, active, edit);
  const placeholders = withLegal ? FOOTER_PLACEHOLDERS : FOOTER_PLACEHOLDERS.filter((name) => !(LEGAL_PLACEHOLDERS as readonly string[]).includes(name));
  return (
    <>
      <div>
        <h3>Anzahl Spalten</h3>
        <Segmented label="Anzahl der Spalten" options={COUNT_OPTIONS} value={String(count)} onChange={(value) => onCount(Number(value))} />
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
                  onFocusColumn(index);
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
    </>
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

/** Spalten des Fußes und die Registerangaben an ihrer Stelle: als weitere Spalte, als Zeile darunter oder untereinander in der Randspalte */
function FooterSheetPreview({
  columns,
  legal,
  stelle,
  align,
}: {
  columns: FormattedTextRun[][][];
  legal: string[];
  stelle: PflichtangabenStelle;
  align: FooterAlign;
}) {
  const asColumn = legal.length > 0 && stelle !== "zeile";
  const all = asColumn ? [...columns, plain(legal)] : columns;
  return (
    <div className="footer-preview" data-stelle={stelle} data-align={align}>
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
