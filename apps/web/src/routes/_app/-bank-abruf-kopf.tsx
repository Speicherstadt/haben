import { useId, type Dispatch, type SetStateAction } from "react";
import { type FintsZustand, wartetAuf } from "../../components/FintsAbruf.tsx";
import type { Data } from "./-bank-daten.ts";

/** Grund, aus dem „Über FinTS verbinden“ gesperrt ist, oder null */
function verbindenGesperrt(fints: Data["fints"], zustand: FintsZustand): string | null {
  const sobald = wartetAuf(fints.connections, zustand);
  return sobald ? `„Über FinTS verbinden“ geht wieder, sobald ${sobald}.` : null;
}

/**
 * Kopf des Bereichs mit „Bank verbinden“ und „Über FinTS verbinden“. Ist an der Zeile einer FinTS-Verbindung ein Schritt
 * der Bank offen, etwa die TAN nach „Jetzt abrufen“, ist „Über FinTS verbinden“ gesperrt: Der Schritt beim Verbinden
 * ersetzte ihn, ohne dass Haben den Vorgang bei der Bank verwirft (#1647). Ebenso, solange an der Zeile „Rufe ab …“ steht,
 * denn die Bank kann darauf mit einem Schritt antworten (#1660). Gehört der Schritt zum Verbinden selbst, bleibt der Knopf
 * frei und klappt das Formular zu wie „Abbrechen“
 */
export function AbrufKopf({
  sync,
  fints,
  busy,
  fintsZustand,
  setConnecting,
}: {
  sync: Data["sync"];
  fints: Data["fints"];
  busy: boolean;
  fintsZustand: FintsZustand;
  setConnecting: Dispatch<SetStateAction<boolean>>;
}) {
  const hinweis = useId();
  const grund = verbindenGesperrt(fints, fintsZustand);
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Automatischer Abruf</h2>
        <div className="actions">
          {sync.configured && (
            <button type="button" className="btn" onClick={() => setConnecting((v) => !v)} disabled={busy}>
              Bank verbinden
            </button>
          )}
          {fints.configured && (
            <button
              type="button"
              className="btn"
              onClick={() => fintsZustand.setVerbinden((v) => !v)}
              disabled={busy || grund !== null}
              aria-describedby={grund ? hinweis : undefined}
            >
              Über FinTS verbinden
            </button>
          )}
        </div>
      </div>
      {grund && (
        <p id={hinweis} className="small muted" style={{ margin: 0 }}>
          {grund}
        </p>
      )}
    </>
  );
}
