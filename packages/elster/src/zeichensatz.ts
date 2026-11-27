/**
 * Zeichensatz Standard_E_V2 der ElsterNachricht-Datenarten: Muster von StringZUBaseSType in Eing_sonstNachr-22.xsd und
 * Eing_Vorauszlg-22.xsd (ERiC-Dokumentation 44.3.6.0), dazu Blatt „Zeichensatz“ der Jahresdokumentationen; dieselben
 * Zeichen erlaubt der TransferHeader aller Datenarten (th000011_extern.xsd). Typografische Zeichen, die Haben selbst
 * schreibt (Gedankenstrich im Zeitraum, Mittelpunkt im Firmennamen, deutsche Anführungszeichen, geschütztes Leerzeichen
 * vor €), fehlen darin; ERiC lehnt das XML dann beim Validieren ab (610301200).
 */
const UNGUELTIG = /[^\n\r\x20-\x7e\xa1-\xa3\xa5\xa7\xaa-\xac\xae-\xb3\xb5\xb9-\xbb\xbf-\xffŒœŠšŸŽž€]/u;

const ERSATZ: Record<string, string> = {
  "\t": " ",
  " ": " ", // geschütztes Leerzeichen (formatEuro vor €)
  " ": " ", // schmales geschütztes Leerzeichen
  " ": " ", // schmales Leerzeichen
  "–": "-",
  "—": "-",
  "‑": "-",
  "−": "-",
  "·": "-",
  "•": "-",
  "„": '"',
  "“": '"',
  "”": '"',
  "‚": "'",
  "‘": "'",
  "’": "'",
  "´": "'",
  "…": "...",
};

/** Ersetzt typografische Zeichen durch ihre einfache Form */
export function zeichenErsetzen(text: string): string {
  return [...text].map((zeichen) => ERSATZ[zeichen] ?? zeichen).join("");
}

/** Das erste Zeichen außerhalb des Zeichensatzes, sonst undefined */
export function ungueltigesZeichen(text: string): string | undefined {
  return UNGUELTIG.exec(text)?.[0];
}
