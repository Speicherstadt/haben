---
title: "Entscheidung: Kontenrahmen je Jahr und frühere Konten"
description: >-
  Entscheidung zu #2043: Eine Buchung steht auf dem Konto, das DATEV im Buchungsjahr führt; frühere Konten
  stehen in einer Liste, bestehende Buchungen bleiben unverändert.
---

# Entscheidung: Kontenrahmen je Jahr und frühere Konten

**Status:** umgesetzt mit #2043. **Stand:** DATEV-Kontenrahmen 2026 (`HABEN_KONTENRAHMEN_STAND`).
**Bezug:** [#2043](https://github.com/Speicherstadt/haben/issues/2043), [#2015](https://github.com/Speicherstadt/haben/issues/2015) (Homeoffice),
[#899](https://github.com/Speicherstadt/haben/issues/899) (Kleinunternehmer), [Buchhaltung: Neue Ausgabe des Kontenrahmens](../buchhaltung.md#neue-ausgabe-des-kontenrahmens).
DATEV: [Programmänderungen Kanzlei-Rechnungswesen 13.3](https://apps.datev.de/myupdates/product-change/details/rel.1037625.productversion_i20241002140543480010133) (Kontenrahmen 2025),
[Kontenrahmenänderungen 2024/2025](https://apps.datev.de/knowledge/help/documents/0907106) (Dok.-Nr. 0907106),
[Optimierung und Bereinigung 2024 bis 2027](https://apps.datev.de/knowledge/help/documents/1029365) (Dok.-Nr. 1029365, Stand 16.10.2026).

## Ausgangslage

DATEV gibt SKR03 und SKR04 je Jahr heraus. Der Kontenrahmen trägt den Vermerk „Gültig für 2026“, die Doku spricht von
„SKR03 2025“, und zwischen zwei Ausgaben kommen Konten dazu, werden umbenannt, reserviert oder gelöscht. Von 2024 bis 2027
bereinigt DATEV die Kontenrahmen; eine reservierte Nummer kann DATEV nach zwei Jahren neu belegen, und auf ein
reserviertes Konto lässt sich in DATEV nicht buchen (Dok.-Nr. 1029365). Dieselbe Nummer bedeutet also nicht in jedem Jahr
dasselbe.

Haben ordnete bisher alle Buchungen jedes Jahres nach einer Ausgabe zu. Zwei Konten, die Haben bebucht, gibt es bei DATEV
erst „ab dem Jahr 2025“:

| Zweck | bis 2024 | ab 2025 | in Haben umgestellt |
| --- | --- | --- | --- |
| Homeoffice-Tagespauschale | 4288 / 6348, das Konto des häuslichen Arbeitszimmers | 4287 / 6347 | #2015 |
| Erlöse als Kleinunternehmer | 8195 / 4185 | 8192 / 4184 | #899 |

Nach #2015 stand eine für 2024 nachgetragene Homeoffice-Pauschale auf 4287, einem Konto, das der Kontenrahmen 2024 nicht
kennt. Das trifft nicht nur Nachträge: Hebt Haben im Januar auf eine neue Ausgabe an, wird noch monatelang ins Vorjahr
gebucht (Abschreibungen, Pauschalen, späte Belege), und der DATEV-Stapel des Vorjahres trüge Konten der neuen Ausgabe.

Frühere Konten führte jede Stelle für sich: je eine Liste für Kleinunternehmererlöse, Sachentnahmen und Pauschalen, in
sechs Dateien einzeln ausgewertet.

Von den Konten, die DATEV zwischen 2024 und 2027 reserviert oder löscht, bebucht Haben keines.

## Entscheidungen

### 1. Das Konto richtet sich nach dem Buchungsjahr

Eine neue Buchung steht auf dem Konto, das DATEV im Jahr ihres Buchungsdatums führt. Haben rechnet nur im Kalenderjahr,
das Buchungsjahr ist also das Wirtschaftsjahr des DATEV-Stapels. Dieselbe Regel gilt schon für die anderen Jahreswerte:
Lohnsteuer und Sozialversicherung rechnen mit den Werten des Jahres, die E-Bilanz sendet in der Taxonomie des
Wirtschaftsjahres.

Die Module kontieren weiter mit den Konten der neuesten Ausgabe. `ledger.post`, die eine Stelle, die ins Journal
schreibt, setzt für das Buchungsjahr das damalige Konto ein (`kontoImBuchungsjahr`). Was sich geändert hat, steht in
einer Liste, `KONTENAENDERUNGEN` in `packages/core/src/kontenaenderungen.ts`: je Zweck das heutige Konto, das frühere und
das letzte Jahr, in dem das frühere gilt. Eine neue Ausgabe kostet damit eine Zeile je geändertem Konto und keinen
Eingriff in die buchenden Module.

Verworfen:

- **Immer die neueste Ausgabe, auch rückwirkend.** Das war der Stand; der Fehler oben folgt daraus.
- **Buchen in frühere Jahre sperren oder nur warnen.** Nachträge und Umzüge aus anderer Software brauchen frühere Jahre,
  und eine Warnung ließe dem Nutzer nichts, was er tun könnte.
- **Das Jahr an jede buchende Funktion durchreichen.** 39 Stellen schreiben ins Journal; eine vergessene buchte
  stillschweigend auf das neue Konto.

Unverändert bleiben Konten, die der Nutzer oder eine Datei vorgibt: freie Buchung, Datenimport, Eröffnung.

### 2. Bestehende Buchungen bleiben, wie sie sind

- Nie umbuchen. Was festgeschrieben ist, bleibt auf seinem Konto, auch wenn es nach dieser Regel heute woanders stünde.
- Auswertungen lesen ein früheres Konto als sein heutiges (`heutigesKonto`): EÜR, BWA, E-Bilanz, Gesamtumsatz, Nebenbuch.
- Eine Gegenbuchung spiegelt die Konten ihrer Ursprungsbuchung.
- Frühere Nummern bleiben für eigene Konten gesperrt, behalten ihren Namen und wandern beim Wechsel zwischen SKR03 und
  SKR04 auf das heutige Konto ihres Zwecks.

Das alles liest aus der einen Liste. Sie unterscheidet zwei Fälle: DATEV führt das heutige Konto erst ab einem Jahr
(`bisJahr`), oder Haben hat eine eigene Zuordnung berichtigt (Sachentnahme 7 % im SKR04, #598); dann gilt das heutige
Konto für jedes Jahr. Hat das frühere Konto bei DATEV eine eigene Bedeutung, wie das Arbeitszimmer, zählen dort nur
Buchungen der genannten Herkunft wie auf dem heutigen (`nurHerkunft`).

Ein Test je Zeile der Liste prüft, dass das frühere Konto überall wie das heutige behandelt wird, und dass Haben keine
frühere Nummer für etwas anderes neu bebucht.

### 3. Bezeichnungen: der Name der neuesten Ausgabe

Journal, Kontenblatt und Saldenliste zeigen ein Konto über alle Jahre unter einem Namen, dem der neuesten Ausgabe. Ein
Konto, das DATEV nicht mehr führt, behält seinen letzten Namen. Den Namen je Jahr zu führen, lohnt nicht: Die EÜR ordnet
nach Zweck und nicht nach dem Namen, und der DATEV-Stapel überträgt keine Namen.

### 4. DATEV-Export: die Konten aus dem Journal

Der Export nimmt weiter die Konten, wie sie im Journal stehen. Mit Entscheidung 1 passen neue Buchungen zum Kontenrahmen
ihres Jahres. Im Bestand können Buchungen auf einem Konto stehen, das DATEV in dem Jahr anders oder nicht mehr führt; die
[Doku](../buchhaltung.md#neue-ausgabe-des-kontenrahmens) nennt diese Konten und was die Steuerberatung dazu wissen muss.
Einen Hinweis im Export selbst gibt es nicht; er wäre der nächste Schritt, falls Steuerberatungen danach fragen.

### 5. Die Doku nennt das Jahr, keine künftige Version

Die Doku schreibt, ab welchem Buchungsjahr ein Konto gilt und mit welcher Umstellung der Bestand entstand. Eine
Versionsnummer nennt sie nur, wenn die Version veröffentlicht ist: Wer sie beim Schreiben schätzt, irrt leicht. In
`pauschalen.md` stand „bis Version 0.15.0“, obwohl 0.15.1 noch auf das alte Konto buchte.

## Grenzen

- **Zuordnung über die Kontonummer.** Teilen sich zwei Zwecke heute ein Konto und ändert sich nur einer, reicht die
  Liste nicht; dann wählt die buchende Stelle das Konto selbst nach dem Jahr.
- **Neu belegte Nummern.** Führt DATEV eine frühere Nummer mit neuer Bedeutung wieder ein und will Haben sie bebuchen,
  schlägt der Test an. Dann braucht `heutigesKonto` das Buchungsjahr, damit alte Buchungen ihren Zweck behalten.
- **Storno mit eigener Urkunde.** Eine Stornorechnung ist eine neue Buchung mit eigenem Datum und bucht nach ihrem Jahr,
  nicht nach dem der Rechnung.
- **Was geprüft ist.** Die neuen Konten aus den Programmänderungen zum Kontenrahmen 2025 und die Reservierungen 2024 bis
  2027 (Dok.-Nr. 1029365). Die vollständigen Änderungslisten 2024/2025 und 2025/2026 sind noch nicht Konto für Konto
  gegen Haben abgeglichen, ältere Ausgaben gar nicht; für diese Jahre gilt die Liste, soweit sie reicht.
- **Belege je Konto.** Der Abgleich „Vorgang gegen Buchung“ vergleicht Belege je Konto. Ändert sich das Konto einer
  Ausgabenkategorie, muss er frühere Konten über `heutigesKonto` lesen. Bisher gibt es keinen solchen Fall.
