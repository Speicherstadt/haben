---
name: "release"
description: "Eine neue Version von Haben veröffentlichen (Release Candidate, Minor oder Patch) und danach prüfen, dass Image, GitHub-Release und das Schließen der Issues durchgelaufen sind. Wenn der Maintainer ein Release will oder fragt, ob eins fällig ist."
---

# Release

Wie Haben veröffentlicht wird, steht in [`docs/entwicklung.md`](../../../docs/entwicklung.md) unter „Veröffentlichen“ und „Release Candidates“; was mit den Issues passiert, in [`docs/mitwirken.md`](../../../docs/mitwirken.md) unter „Branches, Titel und Commits“ (Vom Issue zum Release). Image, Tags, GitHub-Release und das Schließen der Issues macht `.github/workflows/release.yml`, sobald der Tag da ist. Dieser Skill entscheidet, prüft und kontrolliert.

**Ausgelöst wird nur nach ausdrücklichem OK des Maintainers.** Ein Release geht an alle Nutzer, und ob ein RC stabil ist, entscheidet er nach seinem Test.

## 1. Stand

```sh
git fetch origin main --tags
bun scripts/release/vorschau.ts
```

Das Skript nennt den letzten Tag (nur `v…`, nicht die Tags der Pakete wie `gobd-kern-v…`), die Commits seitdem, einen Vorschlag für die Art aus Schritt 2, die Issues, die eine fertige Version schließt, und die Hinweise für das Release aus Schritt 3.

Die Squash-Commits auf `main` sind die PR-Beschreibungen; ihre erste Zeile ist der Titel mit `(#PR)`.

## 2. Art vorschlagen

| Lage | Vorschlag | Ergebnis aus `0.7.0` |
| --- | --- | --- |
| Neue Migrationen (`apps/web/drizzle/*.sql`) oder Änderungen an Festschreibung, Audit-Log, Siegeln oder ELSTER (`packages/elster`, ERiC, Übermittlung) | erst ein RC: `preminor` (neue Funktionen) oder `prepatch` (nur Fixes) | `v0.8.0-rc.1` bzw. `v0.7.1-rc.1` |
| Neue Funktionen ohne das oben | `minor` | `v0.8.0` |
| Nur Fixes und Doku | `patch` | `v0.7.1` |
| RC läuft, Fix nachgeschoben | `prerelease` | `v0.8.0-rc.2` |
| RC läuft und ist beim Maintainer stabil | `patch` | `v0.8.0` |
| Bruch mit bestehenden Instanzen | `major`, nur auf ausdrücklichen Wunsch | |

Den Vorschlag des Skripts gegen die Tabelle halten: Es erkennt Migrationen, `packages/elster` und `packages/gobd-kern`; Änderungen an Festschreibung, Audit-Log, Siegeln oder an ERiC und Übermittlung in `apps/web` und ob neue Funktionen dabei sind, entscheiden die Titel.

## 3. Vorher prüfen

- **CI auf `main` grün** für den aktuellen Stand (letzter Lauf von `ci.yml` auf `main`).
- **Zwischen RC und fertiger Version nur Fixes:** `git log --oneline <rc-tag>..origin/main` darf keine neuen Funktionen enthalten; sonst erst ein weiterer RC.
- **Was geschlossen wird:** Eine fertige Version schließt jedes Issue, das seit der vorigen fertigen Version mit `Umgesetzt #…` gemergt wurde. Vor dem Tag nennt sie das Skript aus Schritt 1, nach dem Tag zeigt `bun scripts/board/release.ts vX.Y.Z --probe` dieselbe Liste.
- **Karten in „Im nächsten Release“, deren PR nur `Refs` hat:** Die schließt das Release nicht. Dem Maintainer melden; er schließt sie danach von Hand (Skill `board-pflegen`).
- **Offene Teile:** Karten in „In Arbeit“, deren Pull Requests seit der vorigen fertigen Version alle nur mit `Refs` gemergt sind und für die kein offener Pull Request mehr da ist. Als Liste dem Maintainer vorlegen, bevor er das Release freigibt: Was fertig ist, bekommt im letzten Pull Request `Umgesetzt` (zählt auch nach dem Merge, `scripts/board/release.ts`) oder wird nach dem Release geschlossen (Skill `board-pflegen`, „offene Teile“).
- **Offene Pull Requests**, die mit hinein sollen: beim Maintainer nachfragen.
- **Hinweise für das Release:** die Abschnitte `## Für das Release` aus den Squash-Commits (`docs/mitwirken.md`, „Branches, Titel und Commits“), beim RC seit dem letzten Tag, bei einer fertigen Version seit der vorigen fertigen Version. Das Skript aus Schritt 1 setzt sie je Pull Request unter seinem Titel zusammen; wo ein Abschnitt endet, steht in `hinweis` (`scripts/release/regel.ts`). Was nur für Entwickler gilt, streichen; Zeilenumbrüche mitten im Satz zusammenziehen.

## 4. Vorschlag an den Maintainer

Kurz: vorgeschlagene Art und Version mit Grund, die Liste der Änderungen (Titel der Squash-Commits), die Issues, die geschlossen werden, die Hinweise für das Release im Wortlaut und offene Punkte aus Schritt 3. Auf sein OK warten, auch für den Text der Hinweise.

## 5. Auslösen

Actions → **Bump version** (`bump.yml`) mit `bump` = die gewählte Art, auf `main`. Mit einem GitHub-Werkzeug: Workflow `bump.yml` per `workflow_dispatch`, Ref `main`, Input `bump`. Der Workflow erhöht die Version in `package.json`, committet „Release vX.Y.Z“ auf `main`, taggt, und der Tag startet `release.yml`.

## 6. Danach kontrollieren

- `release.yml` auf dem Tag: alle Jobs grün (`checks` übersprungen, wenn `main` schon geprüft war).
- Docker Hub und GHCR: Tags `:x.y.z` und `:x.y`, `:latest` nur bei einer fertigen Version; beim RC `:x.y.z-rc.n` und `:next`.
- GitHub-Release mit der Erweiterung „Haben für Mein ELSTER“ als ZIP und `haben-sollbestand-X.Y.Z.json`, in den Notizen die Zeile „Prüfsumme der Sperren“ (Job `sollbestand`); beim RC als Pre-release mit `haben-sollbestand-X.Y.Z-rc.n.json`.
- Hinweise aus Schritt 3, wenn es welche gibt, über die erzeugten Notizen setzen:

  ```sh
  gh release view vX.Y.Z --json body -q .body > notizen.md
  { printf '## Hinweise zum Update\n\n'; cat hinweise.md; printf '\n'; cat notizen.md; } > release.md
  gh release edit vX.Y.Z --notes-file release.md
  ```

  Die Ankündigung in Discord (`discord-release.yml`) ging schon ohne die Hinweise raus. Betrifft ein Hinweis Daten, den Maintainer fragen, ob er sie mit Actions → *Discord-Release* und dem Tag noch einmal ankündigen will.
- Fertige Version: Job `issues-schliessen` grün, seine Ausgabe nennt die geschlossenen Issues; im Project stehen sie in „Erledigt“.
- Etwas rot: nicht neu taggen; Ursache melden, beheben, beim RC `prerelease`, sonst `patch`. Scheitert nur der Job `sollbestand` (etwa am Netz), reicht es, ihn neu zu starten; er ersetzt die Datei und schreibt die Zeile nicht doppelt.

## 7. Beim RC: Testauftrag

Für den Server des Maintainers einen Auftrag erzeugen, angepasst an das, was der RC ändert:

```text
Teste auf diesem Server den Release Candidate vX.Y.Z-rc.N von Haben (Image-Tag :X.Y.Z-rc.N, auch :next). Die Instanz ist eine Testinstanz.

Regeln: Vor dem Update ein Backup von Datenbank und Dateien machen und prüfen. Nichts an ELSTER senden außer mit Testmerker, keine Mails an echte Kunden. Testdaten danach stornieren. Bei einem Fehler anhalten, Logs sichern, berichten.

Ablauf: Version notieren, Backup, Image umstellen und starten (Migrationen ohne Fehler?), dann prüfen:
<je Änderung des RC ein Punkt, etwa: Abgleich von Journal, Umsatzsteuer und EÜR; freie Buchung anlegen und stornieren; ELSTER-Test mit Testmerker; Entwurf-PDF; Bankabruf; Backup-Job>

Bericht: Version vorher/nachher, Ergebnis je Punkt, Fehler mit Log-Auszug ohne Zugangsdaten, Steuernummern oder IBANs, Einschätzung: freigeben oder Fix und nächster RC.
```
