/**
 * Herkunft des Ziels der Sicherung (#1513): aus dem Abschnitt einer rclone-Konfiguration, aus einer
 * Verbindungszeichenkette im Ziel selbst oder als RESTIC_REPOSITORY direkt im Backup-Container. Ein Ziel, das
 * später in Haben eingetragen wird, kommt aus dem Dialog statt aus der Datei; solange es den nicht gibt, bleibt es
 * bei den drei Formen. Die Formen spiegeln rclone_ziel_abschnitt in deploy/backup/restic-ziel.sh, backup-ziel.test.ts
 * hält beide zusammen.
 */

/** Wo der Backup-Container die rclone-Konfiguration sucht, in dieser Reihenfolge wie rclone_config_file in deploy/backup/rclone-ziel.sh */
export const RCLONE_CONFIG = { variable: "RCLONE_CONFIG", datei: "/var/lib/haben-backup/rclone.conf" } as const;

export interface Ziel {
  /** RESTIC_REPOSITORY ohne Zugangsdaten, wie backup_status ihn führt */
  repository: string;
  /** Verzeichnis im Backup-Container statt eines entfernten Ziels */
  local: boolean;
}

/**
 * Abschnitt aus rclone:<abschnitt>:<pfad>. Eine Verbindungszeichenkette (rclone::<typ>,<parameter>:<pfad>) bringt
 * alles selbst mit und braucht keine Datei, dann bleibt der Abschnitt leer; ohne rclone kommt null zurück.
 */
export function rcloneAbschnitt(repository: string): string | null {
  if (!repository.startsWith("rclone:")) return null;
  return /^rclone:([^:,]*)/.exec(repository)?.[1] ?? "";
}

/** Woher das Ziel kommt, und bei einem Abschnitt aus der Datei sein Name */
export type ZielHerkunft = { art: "datei"; abschnitt: string } | { art: "verbindungszeichenkette" } | { art: "verzeichnis" } | { art: "eingetragen" };

export function zielHerkunft(ziel: Ziel): ZielHerkunft {
  const abschnitt = rcloneAbschnitt(ziel.repository);
  if (abschnitt) return { art: "datei", abschnitt };
  if (abschnitt === "") return { art: "verbindungszeichenkette" };
  return { art: ziel.local ? "verzeichnis" : "eingetragen" };
}
