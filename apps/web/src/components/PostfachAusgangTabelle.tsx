import { formatDate } from "../lib/format.ts";
import { MoreActionsMenu } from "./MoreActionsMenu.tsx";
import { absenderOf, nummerOf } from "./postfach-ausgang-helfer.ts";
import type { Eintrag } from "./use-postfach-ausgang.ts";

type Props = {
  liste: Eintrag[];
  gewaehlt: Set<string>;
  busy: boolean;
  onAlle: () => void;
  onUmschalten: (id: string) => void;
  onUebernehmen: (id: string) => void;
  onAnsehen: (id: string) => void;
  onVerwerfen: (id: string) => void;
};

/**
 * Eine Zeile je wartende Ausgangsrechnung: Nummer, Absender, Eingang, Übernehmen und das Menü „⋯“. Am Desktop eine
 * Tabelle mit festen Spalten; am Handy stehen Absender und Eingang unter der Nummer (Regeln `.postfach-*` in styles.css).
 */
export function PostfachAusgangTabelle({ liste, gewaehlt, busy, onAlle, onUmschalten, onUebernehmen, onAnsehen, onVerwerfen }: Props) {
  return (
    <div className="table">
      <div className="table-row head postfach-zeile postfach-kopf">
        <input type="checkbox" aria-label="Alle auswählen" checked={liste.length > 0 && gewaehlt.size === liste.length} onChange={onAlle} />
        <div>Rechnung</div>
        <div>Absender</div>
        <div>Eingang</div>
        <div />
      </div>
      {liste.map((eintrag) => (
        <div key={eintrag.id} className="table-row postfach-zeile">
          <input
            type="checkbox"
            aria-label={`${nummerOf(eintrag.filename)} auswählen`}
            checked={gewaehlt.has(eintrag.id)}
            onChange={() => onUmschalten(eintrag.id)}
          />
          <div className="postfach-info">
            <div className="mono small postfach-kurz" title={eintrag.subject || eintrag.filename}>
              {nummerOf(eintrag.filename)}
            </div>
            <div className="small muted postfach-kurz" title={eintrag.sender}>
              {absenderOf(eintrag.sender)}
            </div>
            <div className="small muted postfach-eingang">{eintrag.receivedAt ? formatDate(eintrag.receivedAt) : "–"}</div>
          </div>
          <div className="actions postfach-aktion">
            <button
              type="button"
              className="btn btn-primary"
              aria-label={`Übernehmen ${nummerOf(eintrag.filename)}`}
              disabled={busy}
              onClick={() => onUebernehmen(eintrag.id)}
            >
              Übernehmen
            </button>
            <MoreActionsMenu
              label={`Weitere Aktionen zu ${nummerOf(eintrag.filename)}`}
              items={[
                { key: "pdf", label: "PDF ansehen", onSelect: () => onAnsehen(eintrag.id) },
                { key: "verwerfen", label: "Verwerfen", disabled: busy, onSelect: () => onVerwerfen(eintrag.id) },
              ]}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
