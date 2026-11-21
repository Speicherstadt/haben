import { useId, type Dispatch, type SetStateAction } from "react";
import type { FintsOffen } from "../../components/FintsAbruf.tsx";
import type { Data } from "./-bank-daten.ts";

/**
 * Kopf des Bereichs mit „Bank verbinden“ und „Über FinTS verbinden“. Ist an der Zeile einer FinTS-Verbindung ein Schritt
 * der Bank offen, etwa die TAN nach „Jetzt abrufen“, ist „Über FinTS verbinden“ gesperrt: Der Schritt beim Verbinden
 * ersetzte ihn, ohne dass Haben den Vorgang bei der Bank verwirft (#1647). Gehört der Schritt zum Verbinden selbst, bleibt
 * der Knopf frei und klappt das Formular zu wie „Abbrechen“
 */
export function AbrufKopf({
  sync,
  fints,
  busy,
  fintsOffen,
  setConnecting,
  setFintsConnecting,
}: {
  sync: Data["sync"];
  fints: Data["fints"];
  busy: boolean;
  fintsOffen: FintsOffen;
  setConnecting: Dispatch<SetStateAction<boolean>>;
  setFintsConnecting: Dispatch<SetStateAction<boolean>>;
}) {
  const hinweis = useId();
  const zeile = fints.connections.find((c) => c.id === fintsOffen?.fuer);
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
              onClick={() => setFintsConnecting((v) => !v)}
              disabled={busy || zeile !== undefined}
              aria-describedby={zeile ? hinweis : undefined}
            >
              Über FinTS verbinden
            </button>
          )}
        </div>
      </div>
      {zeile && (
        <p id={hinweis} className="small muted" style={{ margin: 0 }}>
          „Über FinTS verbinden“ geht wieder, sobald die Freigabe für {zeile.bankName} gesendet oder abgebrochen ist.
        </p>
      )}
    </>
  );
}
