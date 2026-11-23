import { RCLONE_CONFIG, zielHerkunft } from "../lib/backup-ziel.ts";
import { formatDateTime, formatSize } from "../lib/format.ts";
import type { getBackupStatus } from "../server/functions/backup.ts";

type Status = Awaited<ReturnType<typeof getBackupStatus>>;

export const BACKUP_DOCS = "https://haben.app/installation-backup.html#backup-und-wiederherstellen";
const ZWEITES_SYSTEM_DOCS = "https://haben.app/installation-backup.html#repository-auf-einem-zweiten-system";

const ART = { backup: "Backup", restore_check: "Test-Restore" } as const;

/** Woher das Ziel kommt (#1513); ohne eingetragenes Ziel sagt es der nächste Lauf */
function herkunftText(target: Status["target"]): string {
  if (!target) return "Unbekannt bis zum nächsten Lauf mit aktuellem Backup-Image";
  const herkunft = zielHerkunft(target);
  switch (herkunft.art) {
    case "datei":
      return `Aus der rclone-Konfiguration, Abschnitt ${herkunft.abschnitt}`;
    case "verbindungszeichenkette":
      return "Nicht aus einer Datei, die Verbindungszeichenkette bringt das Ziel selbst mit";
    case "verzeichnis":
      return "Nicht aus einer Datei, ein Verzeichnis im Backup-Container";
    case "eingetragen":
      return "Nicht aus einer Datei, das Ziel steht als RESTIC_REPOSITORY im Backup-Container";
  }
}

/** Beide Wege zur rclone-Konfiguration und das Format des Ziels (#1513) */
function RcloneKonfiguration() {
  return (
    <p className="small muted" style={{ margin: 0 }}>
      Ziele, die restic nicht selbst anspricht, etwa WebDAV, OneDrive oder SMB, gehen über rclone. Im Image zeigt{" "}
      <span className="mono">{RCLONE_CONFIG.variable}</span> schon auf <span className="mono">{RCLONE_CONFIG.datei}</span>; liegt die Datei woanders, setzt du
      die Variable auf diesen Pfad. Ein Ziel nennt einen Abschnitt daraus, etwa <span className="mono">rclone:onedrive:haben</span>. In der Datei stehen
      Zugangsdaten; hier erscheint keine davon.
    </p>
  );
}

/** Stand von Backup und wöchentlichem Test-Restore aus dem Backup-Container (Einstellungen → Export) */
export function BackupCard({ status }: { status: Status }) {
  const { state, overdue, lastBackup, lastCheck, failed, target } = status;
  return (
    <section className="card" aria-labelledby="backup-heading">
      <h2 id="backup-heading">Backup</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Der Backup-Container sichert Datenbank und Belege täglich mit restic und spielt einmal pro Woche das letzte Backup probeweise in eine Wegwerf-Datenbank
        ein: Hash-Kette und Siegel werden geprüft, einige Belege mit ihrer Prüfsumme verglichen. Hier steht das Ergebnis.
      </p>
      {state === "keins" && (
        <div className="banner banner-info">
          Noch kein Backup eingetragen. Ohne Backup-Container (oder mit einem anderen Backup) bleibt das so.{" "}
          <a href={BACKUP_DOCS} target="_blank" rel="noreferrer">
            Backup einrichten
          </a>
        </div>
      )}
      {overdue && (
        <div className="banner banner-danger" role="alert">
          {lastBackup
            ? `Das letzte erfolgreiche Backup ist vom ${formatDateTime(lastBackup.at)}, seitdem lief keins mehr durch. Läuft der Backup-Container?`
            : "Noch kein erfolgreiches Backup."}
        </div>
      )}
      {failed.map(({ kind, run }) => (
        <div key={kind} className="banner banner-danger" role="alert" style={{ overflowWrap: "anywhere" }}>
          {ART[kind]} am {formatDateTime(run.at)} fehlgeschlagen{run.message ? `: ${run.message}` : "."}
        </div>
      ))}
      {state !== "keins" && (
        <dl className="small" style={{ margin: 0, display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px" }}>
          <dt className="muted">Speicherort</dt>
          <dd style={{ margin: 0, overflowWrap: "anywhere" }}>
            {target ? (
              <>
                {target.local ? "Lokal" : "Extern"} · <span className="mono">{target.repository}</span>
                {target.local && (
                  <div className="muted">
                    Liegt das Verzeichnis auf demselben Server, schützt das Backup nicht vor dessen Ausfall.{" "}
                    <a href={ZWEITES_SYSTEM_DOCS} target="_blank" rel="noreferrer">
                      Zweites System einrichten
                    </a>
                  </div>
                )}
              </>
            ) : (
              "Unbekannt: Das nächste Backup mit aktuellem Backup-Image trägt ihn ein"
            )}
          </dd>
          <dt className="muted">Herkunft des Ziels</dt>
          <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{herkunftText(target)}</dd>
          <dt className="muted">Letztes Backup</dt>
          <dd style={{ margin: 0 }}>
            {lastBackup ? (
              <>
                {formatDateTime(lastBackup.at)}
                {lastBackup.bytes !== null && ` · ${formatSize(lastBackup.bytes)}`}
                {lastBackup.snapshot && <span className="mono muted"> · {lastBackup.snapshot}</span>}
              </>
            ) : (
              "–"
            )}
          </dd>
          <dt className="muted">Letzter Test-Restore</dt>
          <dd style={{ margin: 0, overflowWrap: "anywhere" }}>
            {lastCheck ? `${formatDateTime(lastCheck.at)} · ${lastCheck.message}` : "Noch keiner, läuft einmal pro Woche nach dem Backup"}
          </dd>
        </dl>
      )}
      <RcloneKonfiguration />
    </section>
  );
}
