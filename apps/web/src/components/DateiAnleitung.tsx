import { Fragment } from "react";
import type { DateiWeg } from "../lib/psp-wege.ts";

/** `**…**` als fett, `…` in Backticks als Code; mehr Auszeichnung braucht die Anleitung nicht */
function Satz({ text }: { text: string }) {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/)
    .map((teil, i) =>
      teil.startsWith("**") ? (
        <strong key={i}>{teil.slice(2, -2)}</strong>
      ) : teil.startsWith("`") ? (
        <code key={i}>{teil.slice(1, -1)}</code>
      ) : (
        <Fragment key={i}>{teil}</Fragment>
      ),
    );
}

/** Wie man den Export beim Anbieter bekommt (#2008): Schritte, Link und Hinweis aus lib/psp-wege.ts */
export function DateiAnleitung({ weg }: { weg: DateiWeg }) {
  return (
    <div className="stack datei-anleitung" style={{ gap: 8 }}>
      <ol style={{ margin: 0, paddingLeft: 20 }}>
        {weg.anleitung.map((s) => (
          <li key={s}>
            <Satz text={s} />
          </li>
        ))}
      </ol>
      <p className="small" style={{ margin: 0 }}>
        <a href={weg.link.url} target="_blank" rel="noreferrer">
          {weg.link.text}
        </a>
      </p>
      {weg.hinweis && (
        <p className="small muted" style={{ margin: 0 }}>
          {weg.hinweis}
        </p>
      )}
    </div>
  );
}
