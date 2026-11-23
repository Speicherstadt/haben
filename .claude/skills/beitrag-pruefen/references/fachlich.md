# Fachliche Prüfung (Schritt 2, heikel)

Teil von Skill `beitrag-pruefen`.

- Jede fachliche Aussage im Diff sammeln (Konto, Kennzahl, Frist, Satz, Rundung, Feld eines Formats, Business Term).
- Steht die Primärquelle im Kommentar und in der Commit-Nachricht? Fehlt sie, ist das ein Befund.
- Die Quelle selbst lesen und die Aussage daran prüfen, nicht nur ihr Dasein: Gesetz (gesetze-im-internet.de), BMF-Schreiben, Formularanleitung, ERiC-Dokumentation, EN 16931/XRechnung, DATEV-Formatbeschreibung, SKR03/SKR04 im Stand aus `scripts/jahreswerte/datev.ts`. Das Gesetz geht vor DATEV. Ratgeber und Blogs sind keine Quelle. GitHub-Quellen flach in den Scratchpad klonen.
- Gilt die Regel für **SKR03 und SKR04**, **Ist und Soll**, **Einzelunternehmen und GmbH**, und für das richtige Jahr (Rechtsstand, Übergangsregeln)?
- **Gegenrechnen:** für den typischen Fall und einen Randfall (Gutschrift, Jahreswechsel, Kleinunternehmer, Reverse Charge, Teilzahlung, was passt) das Ergebnis selbst aus der Quelle herleiten (Buchungssätze, Beträge in Cent, Kennzahlen, XML-Feld) und mit den Erwartungen in den Tests des Pull Requests vergleichen. Stimmt eine Erwartung nicht mit der Quelle überein, ist das ein Befund; der Test dazu entsteht in `tdd-review`.
- Fehlt ein fachlicher Fall ganz, den die Quelle regelt und Nutzer von Haben haben, ist das ein Befund für „Vollständig“.
- Ergebnis je Aussage: bestätigt (Quelle, Fundstelle), widerspricht (Zitat), nicht prüfbar (warum, z. B. braucht Steuerberatung). Nicht Prüfbares nicht als bestätigt melden.
