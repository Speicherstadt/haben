import { Link } from "@tanstack/react-router";
import { formatDateTime } from "../../lib/format.ts";
import { SevdeskFileFacts } from "./Dateistand.tsx";
import { ImportWaitNotice } from "./FastbillTeile.tsx";
import type { ConnectedSource, ImportRow } from "./umzug-quellen.ts";

const PHASES = { kontakte: "Kontakte", liste: "Belegliste", belege: "Belege und Dateien", fertig: "Fertig" } as const;

export function ImportProgress({ source, run }: { source: ConnectedSource | "accountable"; run: ImportRow }) {
  const progress = run.progress;
  const running = run.status === "laeuft";
  const accountable = source === "accountable";
  return (
    <div className="stack" style={{ gap: 12 }} aria-live="polite">
      <div className="small">
        {run.status === "laeuft" ? `Läuft: ${PHASES[progress.phase]}` : null}
        {run.status === "fertig" ? `Fertig am ${formatDateTime(run.finishedAt ?? run.updatedAt)}` : null}
        {run.status === "fehler" ? "Abgebrochen mit Fehler" : null}
        {run.status === "abgebrochen" ? "Abgebrochen" : null}
      </div>
      <div className="progress-facts">
        {!accountable && (
          <>
            <div>
              <span className="small muted">Kontakte neu</span>
              <strong>{progress.contacts}</strong>
            </div>
            <div>
              <span className="small muted">verknüpft</span>
              <strong>{progress.contactsLinked}</strong>
            </div>
          </>
        )}
        <div>
          <span className="small muted">{source === "sevdesk" ? "Dokumente gefunden" : "Belege gefunden"}</span>
          <strong>{progress.listed}</strong>
        </div>
        <div>
          <span className="small muted">übernommen</span>
          <strong>
            {progress.imported + progress.skipped}
            {progress.listed ? ` / ${progress.listed}` : ""}
          </strong>
        </div>
        <div>
          <span className="small muted">Dateien</span>
          <strong>{progress.files}</strong>
        </div>
        {source === "sevdesk" && progress.sevdeskFiles && <SevdeskFileFacts files={progress.sevdeskFiles} />}
        {(progress.recurring ?? 0) > 0 && (
          <div>
            <span className="small muted">Dauerbelege angehalten</span>
            <strong>{progress.recurring}</strong>
          </div>
        )}
      </div>
      {running && <ImportWaitNotice waitingUntil={progress.waitingUntil} fastbill={source === "fastbill"} updatedAt={run.updatedAt} />}
      {source === "sevdesk" && (
        <div className="banner">
          <p style={{ margin: 0 }}>
            <strong>Kontaktrollen prüfen:</strong> Neue Partner, Interessenten und Kontakte ohne eindeutige sevDesk-Kategorie werden zunächst als Kunden
            angelegt. Bestehende Kontakte erhalten nur zusätzliche eindeutige Rollen; ein früher fälschlich als Kunde importierter Lieferant bleibt deshalb auch
            Kunde. Entferne diese Rolle bei Bedarf unter Kontakte. Vorhandene Nummern bleiben unverändert.
          </p>
        </div>
      )}
      {source === "sevdesk" && progress.sevdeskRecurring && progress.sevdeskRecurring.imported + progress.sevdeskRecurring.known > 0 && (
        <p className="small" style={{ margin: 0 }}>
          {progress.sevdeskRecurring.imported + progress.sevdeskRecurring.known} Vorlagen für{" "}
          <Link to="/rechnungen/wiederkehrend">wiederkehrende Rechnungen</Link> pausiert übernommen; prüfe und aktiviere sie dort.
          {progress.sevdeskRecurring.placeholders.length > 0 && (
            <>
              {" "}
              Platzhalter von sevDesk stehen als Text darin: <span className="mono">{progress.sevdeskRecurring.placeholders.join(" ")}</span>
            </>
          )}
        </p>
      )}
      {source === "sevdesk" && (progress.vatReports ?? 0) > 0 && (
        <p className="small" style={{ margin: 0 }}>
          {progress.vatReports} übermittelte Voranmeldungen archiviert, zu finden unter{" "}
          <Link to="/archiv" search={{ ansicht: "voranmeldungen" }}>
            Voranmeldungen
          </Link>
          .
        </p>
      )}
      {run.error && (
        <div className="banner banner-danger" role="alert">
          {run.error}
        </div>
      )}
      {progress.failed.length > 0 && (
        <details>
          <summary className="small">{progress.failed.length} offene Punkte beim Abruf</summary>
          <ul className="small" style={{ margin: "8px 0 0", paddingLeft: 20 }}>
            {progress.failed.slice(0, 50).map((f) => (
              <li key={f.lexofficeId}>
                {f.number || f.lexofficeId}: {f.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
