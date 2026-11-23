import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RCLONE_CONFIG, rcloneAbschnitt, zielHerkunft } from "./backup-ziel.ts";

const DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKUP = join(DIR, "../../../../deploy/backup");

/** rclone_ziel_abschnitt aus restic-ziel.sh, wie entrypoint.sh und backup.sh sie aufrufen; liest RESTIC_REPOSITORY aus der Umgebung */
function abschnittAusSkript(repository: string): string {
  const r = spawnSync("bash", ["-c", `source "${join(BACKUP, "restic-ziel.sh")}" && rclone_ziel_abschnitt`], {
    env: { ...process.env, RESTIC_REPOSITORY: repository },
    encoding: "utf8",
  });
  expect(r.stderr).toBe("");
  // cut setzt am Ende einen Zeilenumbruch, printf davor nicht
  return r.stdout.replace(/\n$/, "");
}

/** rclone_config_file aus rclone-ziel.sh, mit und ohne gesetztes RCLONE_CONFIG */
function konfigurationsdateiAusSkript(wert: string | undefined): string {
  const env: Record<string, string | undefined> = { ...process.env, RESTIC_REPOSITORY: "rclone:onedrive:haben" };
  if (wert === undefined) delete env.RCLONE_CONFIG;
  else env.RCLONE_CONFIG = wert;
  const r = spawnSync("bash", ["-c", `source "${join(BACKUP, "rclone-ziel.sh")}" && rclone_config_file`], { env, encoding: "utf8" });
  expect(r.stderr).toBe("");
  return r.stdout.replace(/\n$/, "");
}

describe("rcloneAbschnitt", () => {
  it("liest den Abschnitt vor Pfad und Parametern", () => {
    expect(rcloneAbschnitt("rclone:onedrive:haben")).toBe("onedrive");
    expect(rcloneAbschnitt("rclone:fern,pass=GEHEIM:haben")).toBe("fern");
  });

  it("Verbindungszeichenkette braucht keine Datei", () => {
    expect(rcloneAbschnitt("rclone::webdav:haben")).toBe("");
    expect(rcloneAbschnitt("rclone::sftp,host=backup.example:haben")).toBe("");
  });

  it("ohne rclone gibt es keinen Abschnitt", () => {
    for (const repository of ["/backups", "sftp:backup.example:/srv/restic", "s3:https://fsn1.example/bucket/haben", "rest:https://backup.example/haben"])
      expect(rcloneAbschnitt(repository), repository).toBeNull();
  });

  // Verhalten statt Quelltext: dieselbe Funktion aus dem Container, an denselben Adressen wie oben
  it("liefert denselben Abschnitt wie rclone_ziel_abschnitt im Container", () => {
    for (const repository of [
      "rclone:onedrive:haben",
      "rclone:fern,pass=GEHEIM:haben",
      "rclone:webdav,vendor=nextcloud:haben",
      "rclone::webdav:haben",
      "rclone::sftp,host=backup.example:haben",
      "rclone:",
      "/backups",
      "sftp:backup.example:/srv/restic",
    ])
      expect(abschnittAusSkript(repository), repository).toBe(rcloneAbschnitt(repository) ?? "");
  });
});

describe("zielHerkunft", () => {
  it("Abschnitt aus der Datei", () => {
    expect(zielHerkunft({ repository: "rclone:onedrive:haben", local: false })).toEqual({ art: "datei", abschnitt: "onedrive" });
  });

  it("Verbindungszeichenkette im Ziel", () => {
    expect(zielHerkunft({ repository: "rclone::webdav:haben", local: false })).toEqual({ art: "verbindungszeichenkette" });
  });

  it("Verzeichnis im Backup-Container", () => {
    expect(zielHerkunft({ repository: "/backups", local: true })).toEqual({ art: "verzeichnis" });
  });

  // rclone erlaubt Leerzeichen im Abschnitt ([mein backup]); der Name bleibt deshalb stehen
  it("Abschnitt mit Leerzeichen bleibt ein Name", () => {
    expect(zielHerkunft({ repository: "rclone:mein backup:haben", local: false })).toEqual({ art: "datei", abschnitt: "mein backup" });
  });

  it("Ziel von außen als RESTIC_REPOSITORY", () => {
    expect(zielHerkunft({ repository: "sftp:backup.example:/srv/restic/haben", local: false })).toEqual({ art: "eingetragen" });
  });
});

describe("RCLONE_CONFIG", () => {
  // Gefragt wird der Container selbst, nicht sein Quelltext: gesetzte Variable, keine Variable, leer gesetzt
  it("sucht die Datei wie der Backup-Container", () => {
    expect(konfigurationsdateiAusSkript("/sonst/wo/rclone.conf")).toBe("/sonst/wo/rclone.conf");
    expect(konfigurationsdateiAusSkript(undefined)).toBe(RCLONE_CONFIG.datei);
    expect(konfigurationsdateiAusSkript("")).toBe(RCLONE_CONFIG.datei);
    expect(RCLONE_CONFIG).toEqual({ variable: "RCLONE_CONFIG", datei: "/var/lib/haben-backup/rclone.conf" });
  });
});
