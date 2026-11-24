import { type SheetRenderer, useRenderedSheet } from "../lib/use-rendered-sheet.ts";

/** Das echte Blatt aus Typst: dieselbe Vorlage wie das PDF, Seite für Seite aus einem gemeinsamen Bild geschnitten */
export function RenderedSheet<I>({ label, render, input, revision }: { label: string; render: SheetRenderer<I>; input: I; revision: string | null }) {
  const { sheet, failure, outdated, refresh } = useRenderedSheet(render, input, revision);
  return (
    <div className="sheet" aria-label={label}>
      {/* Entsteht beim Tippen: höflich als Status statt alert (DESIGN.md). Solange sie steht, entfällt „Aktualisieren“, ein Knopf genügt */}
      {failure && (
        <div className="banner banner-danger" role="status">
          <span>{failure}</span>
          <button type="button" className="btn btn-sm" onClick={() => void refresh()}>
            Erneut versuchen
          </button>
        </div>
      )}
      {outdated && !failure && (
        <div className="sheet-outdated" role="status">
          <span className="small">Das Blatt zeigt noch den vorigen Stand.</span>
          <button type="button" className="btn btn-sm" onClick={() => void refresh()}>
            Aktualisieren
          </button>
        </div>
      )}
      {sheet ? (
        Array.from({ length: sheet.pages }, (_, page) => (
          <div key={page} className="sheet-page" style={{ aspectRatio: `${sheet.width} / ${sheet.height}` }}>
            <img
              draggable={false}
              src={sheet.url}
              alt={`Seite ${page + 1} von ${sheet.pages}`}
              style={{ height: `${sheet.pages * 100}%`, top: `${page * -100}%` }}
            />
          </div>
        ))
      ) : (
        <div className="sheet-page sheet-page-empty" role="status">
          {!failure && "Vorschau wird gesetzt …"}
        </div>
      )}
      {sheet && (
        <div className="visually-hidden">
          {sheet.text.map(({ part, lines }) => (
            <div key={part} data-teil={part}>
              {lines.map((line, index) => (
                <p key={index}>{line}</p>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
