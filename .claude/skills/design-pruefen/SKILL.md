---
name: "design-pruefen"
description: "Die Oberfläche von Haben prüfen: Audit von ganz Haben, einem Bereich oder einzelnen Bildschirmen, oder Review eines Pull Requests, der das Aussehen ändert. Neben tdd-review und doku-pruefen, nicht statt ihrer; Screenshots der eigenen Änderung macht pr-screenshots."
---

# Design prüfen

Verbindet zwei bewährte Prüfverfahren für Haben – **Impeccable** (`critique` + `audit` + `craft-floor`, [pbakaus/impeccable](https://github.com/pbakaus/impeccable)) und **Web Interface Guidelines** ([vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines)) – mit den Gestaltungsregeln in `DESIGN.md` und dem Beitragsablauf aus `docs/mitwirken.md`. Ergänzt `tdd-review` (Code-Fehler mit rotem Test) und `doku-pruefen` (Markdown).

Zwei Modi:

- **Audit** (ganz Haben, ein Bereich oder ausgewählte Bildschirme): Bericht nach Schritt 2, dann Umsetzungspakete nach Schritt 3.
- **PR-Prüfung** (ein UI-Pull-Request): dieselbe Methode, beschränkt auf Diff, berührte Bildschirme, gemeinsame Komponenten und Vorher/Nachher-Screenshots.

## Harte Regeln

- **Zwei isolierte Subagenten (Pflicht, wenn Subagenten verfügbar sind):** Sicht A (Design-Critique) und Sicht B (Technisches Audit & Guidelines) laufen **parallel und isoliert**, ohne die Ausgabe der jeweils anderen Sicht zu kennen. Erst danach führt die Hauptsession beide zusammen. So verfärben technische Lint-Treffer nicht das visuelle Urteil, und visuelle Eindrücke kürzen das technische Audit nicht ab.
- **Degraded-Banner bei Einzelkontext:** Steht kein Subagent-Werkzeug zur Verfügung (oder in einer schreibgeschützten Delegation), zuerst Sicht A komplett abschließen, erst danach Sicht B laufen lassen – und als erste Zeile des Berichts zwingend ausgeben: `⚠️ DEGRADED: Einzelkontext (<Grund>)`. Eine stille Degradierung gilt als fehlgeschlagener Lauf.
- **Kein Befund ohne Beleg:** jeder Befund nennt den konkreten Screenshot (Bildschirm, Viewport, Theme) oder `datei:zeile` und die verletzte Regel (`DESIGN.md`, Heuristik, WCAG oder Guideline). Kein weichgespültes „könnte man prüfen“, kein reiner Geschmack ohne Beleg.
- **Erst der Bericht, dann konkrete Rückfragen – nie ungefragt bauen:** keine Issues, PRs oder Commits ohne Auftrag. Am Ende eines Audits stehen immer 2–4 konkrete Entscheidungsfragen mit Optionen (außer bei weniger als 3 Prioritäts-Befunden oder rein delegiertem Lauf, dann `Fragen übersprungen: <Grund>`).

## 0. Ziel, Kontext und Nachweise holen

1. **Ziel festlegen:** ganz Haben, ein Bereich (etwa Belege, Bank, Steuern), Route, Komponente oder PR (`git diff --name-only origin/main...<branch>`).
2. **Gestaltungsregeln lesen:** `DESIGN.md` im Wurzelverzeichnis, für Tastatur und Screenreader zusätzlich `docs/barrierefreiheit.md`. Gewollte Abweichungen und feste Vorgaben der Oberfläche respektieren. Haben ist ein Arbeitswerkzeug (Betriebsmodus **Operate**): Präzision, Scanbarkeit und Ruhe zählen mehr als Dekoration. Projektbezogene Personas für Sicht A: Freiberufler, der abends Belege und Bank abarbeitet; Geschäftsführerin einer kleinen GmbH vor dem Jahresabschluss; Steuerberatung, die den DATEV-Export prüft.
3. **Visuelle Wahrheit prüfen:** die Doku-Screenshots `docs/screenshot-*.png` (hell und `-dunkel`) oder die laufende App im Browser, aufgenommen wie in Skill `pr-screenshots` (Modus über `localStorage` `haben-modus`, Desktop 1280 und Handy 375 × 812, nur Testdaten). Bei PR-Prüfung die Vorher/Nachher-Screenshots aus der PR-Beschreibung heranziehen.
4. **Vorhandene Prüfwerkzeuge mitnehmen:** die axe-core-Prüfungen in `apps/web/e2e/barrierefreiheit.spec.ts` und den übrigen E2E-Tests (Ausführen nach Skill `checks`; in der CI laufen sie bei jedem Pull Request) und, falls lokal verfügbar, `impeccable detect`: diese Ergebnisse in Sicht B einbeziehen und klar nennen, was lief und was fehlte.

## 1. Zwei isolierte Sichten ausführen

Je Sicht ein Subagent, ohne eigene Einschätzung im Prompt; er liest seine Datei unter `references/` ganz.

- **Sicht A – Design-Critique** nach `references/critique-rubric.md`, auf Screenshots oder der gerenderten Oberfläche und `DESIGN.md`. Dazu, was die Rubrik nicht enthält: **Design-Spezifität** (eigenständig fürs Produkt oder austauschbarer Einheitsbrei?) und **Emotionale Reise** (Peak-End, Vertrauen bei heiklen Momenten). Personas: 2–3 aus der Tabelle der Rubrik plus 1–2 für Haben aus Schritt 0.
- **Sicht B – Technisches Audit & Web Interface Guidelines** nach `references/audit-und-guidelines.md`, auf Code, CSS-Tokens, Komponenten und den Läufen aus Schritt 0, Punkt 4.

## 2. Zusammenführen und Bericht ausgeben

Beide Sichten in **einem** zusammenhängenden Bericht verweben (nicht bloß hintereinanderkleben): markieren, wo A und B übereinstimmen, was nur Sicht B gefunden hat und welche Detektor-Treffer Fehlalarme sind.

Pflichtstruktur des Berichts:

1. **Herkunftszeile:** `Methode: Dual-Agent (A: <ID/Rolle> · B: <ID/Rolle>)` oder das Degraded-Banner.
2. **Design Health Score (Nielsen `/40`) & Audit Health Score (`/20`):** beide Tabellen mit Bewertungsband und Hauptbefund je Zeile.
3. **Design-Spezifität & Implementation Integrity:** klares Urteil, ob die Oberfläche stimmig aus dem Produkt heraus gebaut ist oder nach Baukasten/Drift wirkt (inkl. Stand automatischer Scans).
4. **Was gut funktioniert:** 2–3 konkrete Stärken, die erhalten bleiben sollen.
5. **Prioritäts-Befunde (`P0`–`P3`):** die wichtigsten Befunde nach Schwere (`P0` blockierend, `P1` wesentlich/WCAG-AA, `P2` störend mit Umweg, `P3` Feinschliff), jeweils mit **Beleg**, **Warum es Nutzer trifft** und **konkretem Fix**.
6. **Persona-Red-Flags:** konkrete Brüche je ausgewählter Persona am Hauptablauf.
7. **Systemische Muster & `file:line`-Liste:** wiederkehrende Lücken (z. B. fehlendes Token, Touch-Ziele) plus kompakte Web-Guidelines-Treffer nach Datei.
8. **Provokante Fragen:** 2–3 zugespitzte Fragen, die bessere Lösungen freilegen.

## 3. Weiter nach Modus

### Modus Audit

Nach dem Bericht die Befunde in **kleine, unabhängige Umsetzungspakete** schneiden (z. B. 1. `P0`/Quick-Wins, 2. Basis-Komponenten/A11y/Touch, 3. komplexer Einzelbereich, 4. Hierarchie & Feinschliff) und die Person mit **2–4 konkreten Auswahlfragen** (Priorität, Umfang, ggf. beabsichtigter Ton/Tabu-Bereiche) entscheiden lassen.

Erst auf Freigabe:
- je Paket ein Issue nach Skill `issue-schreiben`;
- je Paket ein kleiner Pull Request nach Skill `beitrag`; die Bilder für „nachher“ selbst ansehen.

### Modus PR-Prüfung

Den Bericht kompakt auf den PR-Umfang zuschneiden und im Umgangston von `beitrag-pruefen` trennen in **Vor dem Merge (`P0`/`P1`)**, **Vorschläge (`P2`/`P3`)** und **Folge-Issue** (außerhalb des PR-Umfangs). Bei reiner Durchsicht ohne Auftrag erst der Person vorlegen, nicht ungefragt kommentieren.
