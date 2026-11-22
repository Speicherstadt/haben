import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RCLONE_CONFIG, rcloneAbschnitt, zielHerkunft } from "./backup-ziel.ts";

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

  // Derselbe Weg wie im Container: erst nach dem Doppelpunkt, dann vor dem Komma abschneiden
  it("spiegelt rclone_ziel_abschnitt in deploy/backup/restic-ziel.sh", () => {
    const skript = readFileSync(new URL("../../../../deploy/backup/restic-ziel.sh", import.meta.url), "utf8");
    expect(skript).toContain("rclone::*) printf ''");
    expect(skript).toContain("cut -d: -f1 | cut -d, -f1");
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

  it("Ziel von außen als RESTIC_REPOSITORY", () => {
    expect(zielHerkunft({ repository: "sftp:backup.example:/srv/restic/haben", local: false })).toEqual({ art: "eingetragen" });
  });
});

describe("RCLONE_CONFIG", () => {
  // Die Wege sind die des Containers (rclone_config_file in deploy/backup/rclone-ziel.sh), nicht neu erfunden
  it("sucht die Datei wie der Backup-Container", () => {
    const skript = readFileSync(new URL("../../../../deploy/backup/rclone-ziel.sh", import.meta.url), "utf8");
    expect(skript).toContain(`\${RCLONE_CONFIG:-${RCLONE_CONFIG.datei}}`);
    expect(skript).toContain("/var/lib/haben-backup/rclone.conf");
    expect(skript).toContain("rclone:<abschnitt>:<pfad>");
    expect(RCLONE_CONFIG).toEqual({ variable: "RCLONE_CONFIG", datei: "/var/lib/haben-backup/rclone.conf" });
  });
});
