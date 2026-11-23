# Felder, Reihenfolge und Labels

Teil von Skill `board-pflegen`.

| Feld | Werte |
| --- | --- |
| Status | Später, Geplant, In Arbeit, Im nächsten Release, Erledigt |
| Aufwand | S, S–M, M, M–L, L |
| Bereich | Bank und Kasse, Belege, Rechnungen, Steuern, Buchhaltung, Lohn, Umzug, Oberfläche, Plattform |
| Hinweis | Freitext ohne Markdown: Frist, Vorbedingung, wer es übernimmt |

- **Rang** ist die Position in der Spalte, von oben nach unten. Es gibt keine Platznummer; in einer Ansicht keine Sortierung setzen, sonst ist der Rang nicht zu sehen.
- **Reihenfolge in „Geplant“:** zuerst Fehler bei Steuer und Buchung, dann kleine Wünsche aus dem Alltag, dann was Freiberuflern und kleinen GmbHs beim Buchen am meisten fehlt (`docs/roadmap.md`).
- **Eine Karte je Thema.** Gehören mehrere Issues zu einem Thema, stehen sie als eigene Karten direkt untereinander; Hinweis nur auf der ersten. Ein Thema ohne Issue ist ein Entwurf (Draft Item).
- **Nicht ins Board:** Fragen, Sammel-Issues, Interna (Renovate, CI), Themen unter „Bewusst nicht“.
- **`einstieg`:** Label für kleine, abgegrenzte Issues ohne Steuer- oder GoBD-Feinheiten, die niemand übernommen hat. Auch größere Issues, die sich in kleine Pull Requests teilen lassen und deren Ergebnis Tests absichern (etwa Aufräumen ohne Verhaltensänderung).
- **Labels:** Jedes offene Issue hat einen Typ (`fehler`, `wunsch`, `steuer`, `umzug`, `frage`, `technik`, `doku`); die Formulare setzen ihn selbst, Issues per `gh issue create` oder von Agenten oft nicht. Dazu passt, wo es zutrifft, ein Themen-Label (`buchung`, `oberfläche`, `schnittstelle`, `jahreswerte`, `hosting`). Was jedes Label bedeutet, zeigt `gh label list --repo Speicherstadt/haben`. Keine neuen Labels anlegen und keine englischen Doppel wie `bug`: Ein neues Label schlägt der Maintainer vor bzw. legt es an; findet sich eins, das nicht in dieser Liste steht, als Fund in Schritt 3 vorschlagen (ersetzen und löschen oder in die Liste aufnehmen).
