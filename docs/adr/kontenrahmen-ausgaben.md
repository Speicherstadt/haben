---
title: "Entscheidung: Kontenrahmen je Jahr und frühere Konten"
description: >-
  Entscheidung zu #2043: Eine Buchung steht auf dem Konto, das DATEV im Buchungsjahr führt; frühere Konten
  stehen in einer Liste, bestehende Buchungen bleiben unverändert.
---

# Entscheidung: Kontenrahmen je Jahr und frühere Konten

**Status:** angenommen und umgesetzt mit [#2065](https://github.com/Speicherstadt/haben/pull/2065). **Stand:** DATEV-Kontenrahmen 2026 (`HABEN_KONTENRAHMEN_STAND`).
**Bezug:** [#2043](https://github.com/Speicherstadt/haben/issues/2043), [#2015](https://github.com/Speicherstadt/haben/issues/2015) (Homeoffice),
[#899](https://github.com/Speicherstadt/haben/issues/899) (Kleinunternehmer), [Buchhaltung: Neue Ausgabe des Kontenrahmens](../buchhaltung.md#neue-ausgabe-des-kontenrahmens).
DATEV: [Programmänderungen Kanzlei-Rechnungswesen 13.3](https://apps.datev.de/myupdates/product-change/details/rel.1037625.productversion_i20241002140543480010133) (Kontenrahmen 2025),
[Kontenrahmenänderungen 2024/2025](https://apps.datev.de/knowledge/help/documents/0907106) (Dok.-Nr. 0907106),
[Kontenerläuterung zu 8195 bzw. 4185](https://wissensplattform.apps.datev.de/research/document/5360713) (Dok.-Nr. 5360713),
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

Frühere Konten führte jede Stelle für sich: je eine Liste für Kleinunternehmererlöse, Sachentnahmen und Pauschalen, an
mehreren Stellen einzeln ausgewertet.

Die Bereinigung trifft Haben bisher nicht: Von den Konten in den Tabellen von Dok.-Nr. 1029365 bebucht Haben keines.
8195 bzw. 4185 hat DATEV außerhalb dieser Bereinigung gelöscht: Bis 2024 buchte man dort die Kleinunternehmererlöse, 2025
dient das Konto nur noch dem Vorjahresvergleich, 2026 ist es gelöscht (Dok.-Nr. 5360713).

## Entscheidungen

### 1. Das Konto richtet sich nach dem Buchungsjahr

Eine neue Buchung steht auf dem Konto, das DATEV im Jahr ihres Buchungsdatums führt. Haben rechnet nur im Kalenderjahr,
das Buchungsjahr ist also das Wirtschaftsjahr des DATEV-Stapels. Dieselbe Regel gilt schon für die anderen Jahreswerte:
Lohnsteuer und Sozialversicherung rechnen mit den Werten des Jahres, die E-Bilanz sendet in der Taxonomie des
Wirtschaftsjahres.

Die Module kontieren weiter mit den Konten der neuesten Ausgabe. `ledger.post`, die eine Stelle, die ins Journal
schreibt, setzt für das Buchungsjahr das damalige Konto ein (`zeilenFuersJournal`). Was sich geändert hat, steht in
einer Liste, `KONTENAENDERUNGEN` in `packages/core/src/kontenaenderungen.ts`: je Zweck das heutige Konto, das frühere und
das letzte Jahr, in dem das frühere gilt. Eine neue Ausgabe kostet damit eine Zeile je geändertem Konto und keinen
Eingriff in die buchenden Module.

Verworfen:

- **Immer die neueste Ausgabe, auch rückwirkend.** Das war der Stand; der Fehler oben folgt daraus.
- **Buchen in frühere Jahre sperren oder nur warnen.** Nachträge und Umzüge aus anderer Software brauchen frühere Jahre,
  und eine Warnung ließe dem Nutzer nichts, was er tun könnte.
- **Das Jahr an jede buchende Funktion durchreichen.** `post` hat Dutzende Aufrufer; ein vergessener buchte
  stillschweigend auf das neue Konto.

Unverändert bleiben Konten, die der Nutzer oder eine Datei vorgibt: freie Buchung, Datenimport, Eröffnung.

### 2. Bestehende Buchungen bleiben, wie sie sind

- Nie umbuchen. Was festgeschrieben ist, bleibt auf seinem Konto, auch wenn es nach dieser Regel heute woanders stünde.
- Auswertungen lesen ein früheres Konto als sein heutiges (`heutigesKonto`): EÜR, BWA, E-Bilanz, Gesamtumsatz, Nebenbuch,
  Abgleich. Wo eine Auswertung ein Konto nennt oder verlinkt, ist es das, auf dem die Buchungen stehen.
- Eine Gegenbuchung im Jahr ihrer Ursprungsbuchung spiegelt deren Konten, damit sich beide auf demselben Konto
  aufheben. Steht sie in einem anderen Jahr, etwa das Storno einer Bareinnahme von 2024, das die Kasse heute bucht, gilt
  das Konto dieses Jahres: Auf 8195 bzw. 4185 ließe sich 2026 bei DATEV nicht mehr buchen.
- Frühere Nummern bleiben für eigene Konten gesperrt und behalten ihren Namen. Beim Wechsel zwischen SKR03 und SKR04
  wandern sie auf das heutige Konto ihres Zwecks; ein Konto mit eigener Bedeutung bei DATEV (Arbeitszimmer) auf dasselbe
  Konto im anderen Rahmen.

Das alles liest aus der einen Liste. Sie unterscheidet zwei Fälle: DATEV führt das heutige Konto erst ab einem Jahr
(`bisJahr`), oder Haben hat eine eigene Zuordnung berichtigt (Sachentnahme 7 % im SKR04, #598); dann gilt das heutige
Konto für jedes Jahr. Hat das frühere Konto bei DATEV eine eigene Bedeutung, wie das Arbeitszimmer, zählen dort nur
Buchungen der genannten Herkunft wie auf dem heutigen (`nurHerkunft`).

Ein Test je Zeile der Liste prüft, dass das frühere Konto überall wie das heutige behandelt wird, und dass Haben keine
frühere Nummer für etwas anderes neu bebucht.

### 3. Bezeichnungen: ein Name je Konto, nicht je Jahr

Journal, Kontenblatt und Saldenliste zeigen ein Konto über alle Jahre unter einem Namen: dem, den Haben für die neueste
Ausgabe führt. Ein Konto, das DATEV nicht mehr führt, behält seinen letzten Namen. Den Namen je Jahr zu führen, lohnt
nicht: Die EÜR ordnet nach Zweck und nicht nach dem Namen, und der DATEV-Stapel überträgt keine Namen.

### 4. DATEV-Export: die Konten aus dem Journal

Der Export nimmt weiter die Konten, wie sie im Journal stehen. Mit Entscheidung 1 passen neue Buchungen zum Kontenrahmen
ihres Jahres. Im Bestand können Buchungen auf einem Konto stehen, das DATEV in dem Jahr anders, noch nicht oder nicht mehr führt; die
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
- **Was geprüft ist.** Die Änderungslisten 2024/2025 von DATEV für SKR03 und SKR04 (1. Auflage Dezember 2024), Konto für
  Konto gegen die Konten, die Haben bebucht: Neu sind dort nur 4287 bzw. 6347 und 8192 bzw. 4184, reserviert oder gelöscht
  wird keins, und bei 1790/1791 bzw. 3841/3845 ändert sich nur die Beschriftung, die Haben schon führt. Dazu die Tabellen
  der Bereinigung 2024 bis 2027 und der Kontenrahmen 2026: Keins der Konten, die er als für 2026 neu eingeführt kennzeichnet
  (Fußnote 1), bebucht Haben. Ausgaben vor 2024 sind nicht abgeglichen; für diese Jahre gilt die Liste, soweit sie reicht.
- **Homeoffice für 2024.** DATEV führt 2024 den Kontenzweck der Tagespauschale, aber kein Konto dafür; 4288 bzw. 6348
  heißt dort schon „häusliches Arbeitszimmer“. Haben bucht 2024 trotzdem dorthin, weil es das Konto bis 2023 war und
  4287 bzw. 6347 erst ab 2025 gilt. Ob die Steuerberatung für 2024 ein eigenes Konto mit dem Kontenzweck vorzieht, ist
  offen.
- **Kategorien.** Bisher hat sich kein Konto einer Ausgabenkategorie geändert. Der Abgleich „Vorgang gegen Buchung“ liest
  frühere Konten schon als ihr heutiges; einen Fall, der das prüft, gibt es noch nicht.
