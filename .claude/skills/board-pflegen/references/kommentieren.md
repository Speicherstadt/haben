# Kommentieren (Schritt 5, nach OK)

Teil von Skill `board-pflegen`.

Wer ein Issue schreibt, soll wissen, dass es gelesen und wie es eingeordnet wurde. Das OK des Maintainers zur Tabelle aus Schritt 3 ist der Auftrag dafür.

- Ein Kommentar je geprüftem Issue und je Karte, die der Skill anlegt oder in eine andere Spalte schiebt, sofern das Issue noch keinen Kommentar zur Einordnung hat; auch bei Folge-Issues und bei Issues des Maintainers oder seiner Agenten: Wer das Issue später liest, sieht so, wo es steht. Bei eigenen Issues ohne „Danke!“.
- Kurz, auf Deutsch, Du-Form; kein Termin und kein Versprechen; die Begründung aus Schritt 2 mit Link. Kein Hinweis auf das Werkzeug: Der Text ist eine Mitteilung des Maintainers.
- `gh issue comment <n> --repo Speicherstadt/haben --body-file <datei>`

| Ergebnis | Text (Vorlage, anpassen) |
| --- | --- |
| Aufnehmen | Danke! Ist jetzt im [Board](https://github.com/orgs/Speicherstadt/projects/3) unter „Geplant“ (bzw. „Später“), Bereich Belege. Die Reihenfolge in der Spalte ist die Priorität. Wer es übernehmen möchte: [Etwas übernehmen](https://haben.app/mitwirken.html#etwas-übernehmen). Bei `einstieg` zusätzlich: Gut für den Einstieg geeignet. |
| Teilweise | Danke! Ist jetzt im [Board](https://github.com/orgs/Speicherstadt/projects/3) unter „…“, Bereich …, mit diesem Umfang: … Nicht dazu gehört …, weil … ([Bewusst nicht](https://haben.app/roadmap.html#bewusst-nicht), falls dort). |
| Rückfrage | Danke! Damit wir es einordnen können, fehlt noch: … Sobald das da ist, kommt es ins [Board](https://github.com/orgs/Speicherstadt/projects/3). |
| Duplikat | Danke! Das Thema steht schon in #… (bzw. im Entwurf „…“ im [Board](https://github.com/orgs/Speicherstadt/projects/3)). Was hier neu ist (…), ist dort vermerkt. |
| Nicht ins Board | Danke! Das planen wir nicht: [Bewusst nicht](https://haben.app/roadmap.html#bewusst-nicht), Zeile „…“. Kurz der Grund … |
| Erledigt | Danke! Das gibt es seit v… ([Release](https://github.com/Speicherstadt/haben/releases/tag/v…), PR #…). |

Antworten in offenen Gesprächen (Schritt 1) und die Antworten auf Fragen an den Maintainer (Schritt 3) gehen genauso nach OK, mit dem freigegebenen Entwurf; Fragen zu einem PR als Kommentar im PR, nicht im Issue. Bei einer Übernahme: @-Erwähnung, „gehört dir“, Umfang in einem Satz (bei einer Skizze: „Die Skizze passt so“ oder was abweicht), Hinweis auf „In Arbeit“.

**Folge-Issues, nach OK:** Jedes in einer freigegebenen Antwort angekündigte Issue gleich anlegen (`gh issue create --repo Speicherstadt/haben --title "…" --body-file <datei> --label <typ>,<thema>`): Problem, Regel bzw. Vorschlag, Akzeptanzkriterien und ein Link auf den Kommentar mit der Entscheidung. Danach wie „Aufnehmen“ ins Board (Schritt 4) mit Hinweis, etwa wem es angeboten ist, und mit Kommentar zur Einordnung; zugewiesen wird erst nach `/übernehmen`.

Schließen bleibt beim Maintainer, ebenso die Labels `rückmeldung`, `sammlung` und `verbesserung`.
