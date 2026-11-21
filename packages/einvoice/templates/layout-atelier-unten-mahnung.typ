// Atelier, Fuß unten (#113) für Mahnungen: Display-Serif Cormorant Garamond für Name, Überschrift und Beträge, die Schrift der Gestaltung
// für den Rest, Haarlinien in der Akzentfarbe (Vorgabe Gold #B5862A) unter dem Kopf und über dem Fuß, Beschriftungen klein
// und gesperrt. Option Kerndaten: Liste oder zweispaltig. Nach DIN 5008 Form B.
#import "layout-basis.typ": *

#let serif = "Cormorant Garamond"
#let gesperrt(body, farbe: muted) = text(size: 6.8pt, fill: farbe, tracking: 0.14em, upper(body))
#let haar = 0.35pt + accent

#show: seite.with(groesse: 9pt, leading: 0.62em, fuss-farbe: accent)

// Kopf: Logo, Name oder beides, darunter eine Haarlinie in der Akzentfarbe über die ganze Breite. Unterkante des Logos und
// Grundlinie des Namens stehen bei 38,5 mm, bei jeder Logogröße; das Logo wächst nach oben (L, 24 mm, LOGO_SIZES, ab
// 14,5 mm). Die Linie steht 4 mm darunter bei 42,5 mm, über dem Anschriftfeld (ab 45 mm), damit sie im Fensterumschlag
// nicht zu sehen ist
// Steht das Logo links, steht der Name rechts daneben; mittig oder rechts steht nur das Logo
// Grundlinie des Namens an der Unterkante der Box (bottom-edge: baseline)
#let name = text(font: serif, size: 21pt, tracking: 0.02em, d.author)
#if d.at("logo", default: none) != none {
  logo(dy: -5.5mm, unten: 24mm)
  if logo-stelle == "links" { place(top + right, dy: -5.5mm, box(height: 24mm, align(bottom + right, name))) }
} else {
  place(top + left, dy: -5.5mm, box(height: 24mm, align(bottom, name)))
}
#place(top + left, dy: 22.5mm, line(length: satzbreite, stroke: haar))
#anschrift()
// Angaben zum Beleg untereinander, Beschriftung über dem Wert, rechtsbündig mit der Tabelle (bis 190 mm)
#let angabe(m) = stack(spacing: 1.3mm, text(size: 6.4pt, fill: muted, tracking: 0.08em, upper(m.label)), text(font: serif, size: 10.5pt, zusammen(m.value)))
// Option „Kerndaten“: Liste (untereinander, rechtsbündig) oder zweispaltig
#let kerndaten = box(width: 190mm - 125mm, if option("kerndaten", "liste") == "zweispaltig" {
  info-zweispaltig(info-rechts, angabe)
} else {
  stack(spacing: 3.2mm, ..info-rechts.map(m => align(right, angabe(m))))
})
#place(top + left, dx: 125mm - links, dy: info-oben - oben, kerndaten)
// Die Liste ist höher als bei den anderen Layouts; ist sie lang, rückt der Inhalt darunter nach unten
#bis-betreff(ueber: kerndaten)
#if info-rest.len() > 0 {
  let haelfte = calc.ceil(info-rest.len() / 2)
  let spalte(zeilen) = grid(columns: (auto, 1fr), column-gutter: 4mm, row-gutter: 2.2mm,
    ..zeilen.map(m => (gesperrt(m.label), align(right, text(font: serif, size: 8.6pt, m.value)))).flatten())
  block(width: 100%, inset: (y: 2.6mm), stroke: (top: haar, bottom: haar), grid(columns: (1fr, 1fr), column-gutter: 10mm, spalte(info-rest.slice(0, haelfte)), spalte(info-rest.slice(haelfte))))
  v(5mm)
}
#text(font: serif, size: 36pt, d.title)
#if d.reference != none { v(-1mm); text(fill: muted, d.reference) }
#v(7mm)
#let kopf(body) = gesperrt(body)
#let linien(x, y) = if y == 0 { (bottom: haar) } else { (bottom: 0.3pt + rule) }
#mahnung-inhalt(kopf: kopf, stroke: linien)
