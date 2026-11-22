import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackupCard, RCLONE_CONFIG } from "./BackupCard.tsx";

type Status = Parameters<typeof BackupCard>[0]["status"];

const at = new Date("2026-11-17T03:00:00Z");
const ok: Status = {
  state: "ok",
  overdue: false,
  lastBackup: { at, ok: true, snapshot: "4f2a9c1e", bytes: 48234496, message: "" },
  lastCheck: null,
  failed: [],
  target: null,
};

const render = (status: Status) => renderToStaticMarkup(createElement(BackupCard, { status }));

describe("BackupCard: Speicherort (#1331)", () => {
  it("lokales Verzeichnis mit Hinweis auf ein zweites System", () => {
    const html = render({ ...ok, target: { repository: "/backups", local: true } });
    expect(html).toContain("Speicherort");
    expect(html).toContain('Lokal · <span class="mono">/backups</span>');
    expect(html).toContain('href="https://haben.app/installation-backup.html#repository-auf-einem-zweiten-system"');
  });

  it("entferntes Repository ohne Hinweis", () => {
    const html = render({ ...ok, target: { repository: "sftp:backup.example:/srv/restic/haben", local: false } });
    expect(html).toContain('Extern · <span class="mono">sftp:backup.example:/srv/restic/haben</span>');
    expect(html).not.toContain("Zweites System einrichten");
  });

  // Bis zum ersten Lauf nach dem Update mit der Spalte target ist auch ein aktuelles Backup-Image noch ohne Ziel
  it("ohne eingetragenes Ziel: unbekannt bis zum nächsten Backup", () => {
    expect(render(ok)).toContain("Unbekannt: Das nächste Backup mit aktuellem Backup-Image trägt ihn ein");
  });

  it("ohne jeden Lauf keine Zeile Speicherort", () => {
    expect(render({ ...ok, state: "keins", lastBackup: null })).not.toContain("Speicherort");
  });
});

/*
 * #1513, kleinere Stufe: die Seite erklärt die rclone-Konfiguration des Backup-Containers und sagt, ob das Ziel aus
 * dieser Datei kommt. Ein Ziel, das in Haben selbst eingetragen wird (Stufe 2), nennt sie später als aus dem Dialog.
 */
describe("BackupCard: rclone-Konfiguration (#1513)", () => {
  it("nennt beide Wege zur Konfiguration und das Format des Ziels", () => {
    const html = render(ok);
    expect(html).toContain(`<span class="mono">${RCLONE_CONFIG.variable}</span>`);
    expect(html).toContain(`<span class="mono">${RCLONE_CONFIG.datei}</span>`);
    expect(html).toContain('<span class="mono">rclone:onedrive:haben</span>');
    expect(html).toContain("hier erscheint keine davon");
  });

  // Die Wege sind die des Containers (rclone_config_file in deploy/backup/rclone-ziel.sh), nicht neu erfunden
  it("sucht die Datei wie der Backup-Container", () => {
    const skript = readFileSync(new URL("../../../../deploy/backup/rclone-ziel.sh", import.meta.url), "utf8");
    expect(skript).toContain(`\${${RCLONE_CONFIG.variable}:-${RCLONE_CONFIG.datei}}`);
    expect(skript).toContain("rclone:<abschnitt>:<pfad>");
  });

  it("Ziel aus einem Abschnitt der Datei", () => {
    const html = render({ ...ok, target: { repository: "rclone:onedrive:haben", local: false } });
    expect(html).toContain("Herkunft des Ziels");
    expect(html).toContain("Aus der rclone-Konfiguration, Abschnitt onedrive");
  });

  it("Abschnitt mit Parametern im Ziel zählt weiter als aus der Datei", () => {
    expect(render({ ...ok, target: { repository: "rclone:fern,pass=GEHEIM:haben", local: false } })).toContain("Aus der rclone-Konfiguration, Abschnitt fern");
  });

  it("Verbindungszeichenkette im Ziel braucht keine Datei", () => {
    expect(render({ ...ok, target: { repository: "rclone::webdav:haben", local: false } })).toContain(
      "Nicht aus einer Datei, die Verbindungszeichenkette bringt das Ziel selbst mit",
    );
  });

  it("Ziel ohne rclone steht direkt im Backup-Container", () => {
    expect(render({ ...ok, target: { repository: "sftp:backup.example:/srv/restic/haben", local: false } })).toContain(
      "Nicht aus einer Datei, das Ziel steht als RESTIC_REPOSITORY im Backup-Container",
    );
  });

  it("Ziel unbekannt, solange kein Lauf eines eingetragen hat", () => {
    expect(render(ok)).toContain("Unbekannt bis zum nächsten Lauf mit aktuellem Backup-Image");
  });
});
