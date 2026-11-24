---
title: "BWA: betriebswirtschaftliche Auswertung mit Vergleich"
description: >-
  Einnahmen-Ausgaben-BWA nach DATEV-Form 43, Kurzfristige Erfolgsrechnung für GmbH und UG, Kennzahlen,
  Vorjahres- und Periodenvergleich, Drilldown mit „Warum?“ und Grenzen.
---

# BWA

„BWA“ im Kopf der Auswertungen öffnet die betriebswirtschaftliche Auswertung: wie der Betrieb in einem Monat, einem Quartal, einem Jahr oder einem freien Zeitraum (von–bis) dasteht. Sie bucht nichts. Im Einzelunternehmen rechnet sie aus denselben Zahlungen wie die EÜR; über ein ganzes Jahr ist ihre Zeile „Gewinn laut EÜR“ der Gewinn der EÜR (siehe Grenzen). GmbH und UG bekommen die [Kurzfristige Erfolgsrechnung](#bwa-für-gmbh-und-ug) periodengerecht wie die GuV. Zeitraum, Vergleich, „Leere Zeilen anzeigen“ und eine aufgeklappte Zeile stehen in der Adresse, ein Link zeigt also dieselbe Auswertung.

Es ist eine eigene Auswertung von Haben, keine Auswertung von DATEV; im Einzelunternehmen gegliedert wie die Einnahmen-Ausgaben-BWA von DATEV (BWA-Form 43, Zeilen nach der DATEV-Musterauswertung BWA, 2016): Erlöse und sonstige Erlöse, Umsatzsteuer und Erstattung, Kosten nach Kostenart (Material, Fremdleistungen, Personal, Raum, Steuern/Versicherungen/Beiträge, Fahrzeug, Werbe- und Reisekosten, Warenabgabe, Instandhaltung, Abschreibungen, verschiedene Kosten), Buchwert der Anlagenabgänge, Zinsen und sonstige Aufwendungen, Vorsteuer und Umsatzsteuer-Zahlungen, darunter das vorläufige Ergebnis. Welche Kostenart ein Konto hat, folgt den Kontengruppen des DATEV-Kontenrahmens 2026 ([SKR 03](https://www.datev.de/content/dam/markenassets/themen-und-produktgruppen/zielgruppen/mandant/unternehmer/branche/bau/11174%20SKR03%20BilrUg.pdf), [SKR 04](https://www.datev.de/content/dam/markenassets/themen-und-produktgruppen/zielgruppen/mandant/unternehmer/branche/bau/11175%20SKR04%20BilrUg.pdf)), soweit beide Rahmen sie gleich gliedern, sonst dem Posten der GuV; ein [eigenes Konto](buchhaltung.md#eigene-konten) zählt wie seine Kategorie.

| Spalte | Bedeutung |
| --- | --- |
| Zeitraum | Zahlungen (GmbH und UG: Buchungen) im gewählten Zeitraum, beide Tage eingeschlossen; von–bis über höchstens drei Kalenderjahre |
| Anteil | Erlöse in % der Summe der Erlöse, Kosten in % der Summe der Kosten (GmbH und UG [siehe unten](#bwa-für-gmbh-und-ug)), die übrigen Zeilen ohne Anteil, ebenso, wenn die Summe 0 oder negativ ist. DATEV zeigt mehrere Prozentspalten (etwa Kosten auch in % der Gesamtleistung bzw. der Erlöse, in Form 01 auch Neutrales und Ergebnisse), Haben je Zeile eine |
| Vergleich | **Vorjahreszeitraum**: dieselben Kalendertage ein Jahr früher, ganze Monate als ganze Monate (Februar mit Februar, auch im Schaltjahr); **Vorperiode**: gleich viele ganze Monate direkt davor (der Monat, das Quartal, das Jahr davor); bei einem freien Zeitraum, der nicht aus ganzen Monaten besteht, gleich viele Tage direkt davor |
| Abweichung, in % | Zeitraum minus Vergleich, in Prozent des Vergleichs; ohne Prozent, wenn der Vergleich 0 ist |
| Kumuliert | Vom 1. Januar bis zum Ende des Zeitraums; beim Vorjahresvergleich daneben dasselbe im Vorjahr |

Zeilen, die in allen Spalten 0 sind, fehlen, Summen und Ergebnisse ausgenommen; mit **Leere Zeilen anzeigen** steht jede Zeile der Form, etwa um die BWA Zeile für Zeile neben die der Steuerberatung zu legen.

Über der Tabelle stehen **Kennzahlen** für den Zeitraum, mit Vergleich klein darunter der Wert im Vergleichszeitraum, dazu in einer Zeile, was durch was geteilt ist. Die Formeln folgen der DATEV-Musterauswertung BWA (Form 01 S. 3, Spalten „% Ges.-Leistg.“ und „Aufschlag“; Form 43 S. 32, Spalte „% Ges.-Erlöse“); die Rohertragsquote des Einzelunternehmens zieht wie der Rohertrag der Form 01 Material und Fremdleistungen ab:

| Kennzahl | Einzelunternehmen (Form 43) | GmbH und UG (Form 01) |
| --- | --- | --- |
| Rohertragsquote | (Summe der Erlöse − Material − Fremdleistungen) / Summe der Erlöse | Rohertrag / Gesamtleistung |
| Personalkostenquote | Personalkosten / Summe der Erlöse | Personalkosten / Gesamtleistung |
| Kostenquote | Summe der Kosten / Summe der Erlöse | Gesamtkosten / Gesamtleistung |
| Umsatzrendite | (Summe der Erlöse − Summe der Kosten − Buchwert der Anlagenabgänge − Zinsen und sonstige Aufwendungen) / Summe der Erlöse | Vorläufiges Ergebnis / Gesamtleistung |
| Aufschlag | – | Rohertrag / Material- und Wareneinkauf, nur wenn Material gebucht ist |

Die Umsatzrendite im Einzelunternehmen rechnet ohne Umsatzsteuer und Vorsteuer, denn die schwanken im Monat mit den Zahlungen an das Finanzamt; DATEV teilt dort das Ergebnis mit Steuern durch die Betriebseinnahmen. Ist der Nenner 0 oder negativ, steht „–“.

Anders als die EÜR zählt die BWA nicht abziehbare Ausgaben (30 % der Bewirtung, Gewerbesteuer, nicht abziehbare Nebenleistungen) als Kosten, denn bezahlt sind sie trotzdem. Die Zeile „nicht abziehbare Ausgaben“ darunter führt zum Gewinn laut EÜR. Eine Umsatzsteuer-Vorauszahlung, die die EÜR dem Vorjahr zurechnet ([Vorauszahlung um den Jahreswechsel](auswertungen.md#umsatzsteuer-vorauszahlung-um-den-jahreswechsel)), steht in der BWA am 31. Dezember des Vorjahres.

Ein Klick auf eine Zeile mit Beträgen zeigt darunter, was darin steht: je Zeile der EÜR die Zahlungen mit Datum, Betrag und Link zur Rechnung oder zum Beleg. Die Kontonummer führt zum Kontenblatt; das zeigt die Buchungen nach Buchungsdatum, nicht nach Zahlung. Zahlungen ohne Rechnung und Beleg, etwa Lohn oder Umsatzsteuer an das Finanzamt, führen zu ihrer Buchung im Kontenblatt: am Tag der Zahlung, auch wenn die BWA sie am 31. Dezember des Vorjahres zeigt, die Zeile markiert.

Mit einem Vergleich steht darüber „Warum?“: die Abweichung der Zeile nach Kontakt, die fünf größten einzeln, der Rest als „übrige“. Zusammen ergeben sie genau die Abweichung der Zeile.

- **neu**: im Vergleich keine Zahlung mit dem Kontakt; **weggefallen**: jetzt keine; sonst **gestiegen** oder **gesunken**.
- Die Spalte „Vorgänge“ zeigt Anzahl und Betrag je Zahlung („3 × 240,00 € statt 1 × 90,00 €“), also ob es mehr Zahlungen waren oder höhere Beträge; drei Teilzahlungen auf eine Rechnung zählen dreimal.
- Kontakt ist der Kunde der bezahlten Rechnung bzw. der Lieferant des Belegs; bei einer Rechnung oder einem Beleg aus Lexware Office ohne eigenen Kontakt der Kontakt am archivierten Beleg. Ein verknüpfter Kontakt ist verlinkt, für die Steuerberatung nicht, weil sie keine Kontakte öffnet.
    - Vorgänge desselben Kunden bzw. Lieferanten stehen in einer Zeile, mit und ohne Kontakt: gleicher Kontakt, gleiche USt-IdNr. oder gleicher Name (ohne Groß- und Kleinschreibung, auch Name und USt-IdNr. am Kontakt), auch über mehrere Schritte.
    - Zwei Kontakte stehen nie in einer Zeile. Passen Vorgänge ohne Kontakt, allein oder erst zusammen, zu zwei Kontakten, stehen sie bei keinem, sondern in einer eigenen Zeile mit den übrigen Vorgängen ohne Kontakt, die bei keinem Kontakt stehen und denselben Namen oder dieselbe USt-IdNr. tragen.
    - Ohne Kontakt, Namen und USt-IdNr. und bei Zahlungen ohne Rechnung und Beleg (Pauschalen, Lohn, Finanzamt) steht der Betrag unter „Ohne Kontakt“.

Grenzen:

- Abschreibungen, Restbuchwerte und die Privatnutzung von Fahrzeugen zeigt die BWA erst, wenn das Jahr im [Anlagenverzeichnis](anlagen.md) gebucht ist. Die EÜR rechnet sie vorher schon aus dem Anlagenverzeichnis; bis dahin weicht der Gewinn ab, und die BWA weist darauf hin.
- Im Einzelunternehmen stehen Zinserträge und andere steuerfreie Einnahmen bei den Erlösen, weil die EÜR sie in einer Zeile mit den steuerfreien Umsätzen führt.

## BWA für GmbH und UG

GmbH und UG bilanzieren; ihre BWA ist eine eigene Auswertung von Haben, gegliedert wie die Kurzfristige Erfolgsrechnung von DATEV (BWA-Form 01, Musterauswertung BWA, 2016): Umsatzerlöse, Bestandsveränderungen und aktivierte Eigenleistungen bis zur Gesamtleistung, Material- und Wareneinkauf (mit Fremdleistungen) bis zum Rohertrag, sonstige betriebliche Erlöse, die Kostenarten bis zum Betriebsergebnis, dann neutraler Aufwand (Zinsen, sonstiger neutraler Aufwand) und neutraler Ertrag (Zinserträge, sonstiger neutraler Ertrag, verrechnete kalkulatorische Kosten), das Ergebnis vor Steuern, die Steuern vom Einkommen und Ertrag (mit der Gewerbesteuer) und das vorläufige Ergebnis. Spalten, Vergleich und leere Zeilen wie oben; der **Anteil** steht für Leistung, Material und sonstige Erlöse bis zum betrieblichen Rohertrag in % der Gesamtleistung, für die Kostenarten in % der Gesamtkosten, nicht für Neutrales, Steuern und Ergebnisse.

Sie rechnet aus den Salden der Erfolgskonten im Journal nach Buchungsdatum, mit manuellen Buchungen, ohne Eröffnungsbuchungen. Welche Zeile ein Konto hat, folgt den Kontengruppen des DATEV-Kontenrahmens 2026 wie oben. **Neutral** sind im SKR03 die übrigen Abgrenzungskonten der Klasse 2, etwa Forderungsverluste (2400), nicht abziehbare Vorsteuer (2170 bis 2176), Kursdifferenzen (2150, 2660; [§ 277 Abs. 5 HGB](https://www.gesetze-im-internet.de/hgb/__277.html) verlangt die Währungsumrechnung gesondert), Anlagenabgänge, Spenden und periodenfremde Posten; im SKR04 die gleich benannten Konten (6930, 6860 bis 6871, 6880, 4840 …). Neutral ist auch die nicht abziehbare Vorsteuer außerhalb der Klasse 2 (SKR03 3600 und 4300, SKR04 5600) und die Erlöse aus Anlagenverkäufen (SKR03 8800 bis 8839, SKR04 4844 bis 4852 und 6884 bis 6892): Ein Anlagenabgang steht mit Erlös und Restbuchwert im neutralen Ergebnis. Neutral sind auch die Abschreibungen auf Finanzanlagen und auf Wertpapiere des Umlaufvermögens (SKR03 4866 bis 4878, SKR04 7200 bis 7255): Sie gehören zum Finanzergebnis ([§ 275 Abs. 2 Nr. 12 HGB](https://www.gesetze-im-internet.de/hgb/__275.html)). Konten der Ergebnisverwendung nach dem Jahresergebnis (Einstellungen in Rücklagen, Gewinnvortrag, Vorabausschüttung) fehlen wie in der GuV. Ein Erfolgskonto, das im Kontenrahmen in einer Lücke liegt, steht unter „Kontenklasse unbesetzt“.

Über ein ganzes Jahr ist das vorläufige Ergebnis der Jahresüberschuss bzw. Jahresfehlbetrag der [GuV im Jahresabschluss](gmbh-abschluss.md), solange nichts unter „Kontenklasse unbesetzt“ steht (die GuV führt solche Konten als nicht zugeordnet). Vorläufig ist es, weil Abschlussbuchungen (Rückstellungen, Abgrenzungen, AfA) erst gebucht zählen; was davon noch fehlt, fehlt auch hier.

Ein Klick auf eine Zeile zeigt ihre Konten mit Betrag, ohne „Warum?“; die Kontonummer öffnet das Kontenblatt für genau den Zeitraum der BWA. Reicht der Zeitraum über den Jahreswechsel, zeigt das Kontenblatt das letzte Jahr darin ab dem 1. Januar.
