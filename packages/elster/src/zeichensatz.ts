import { ElsterEingabeError } from "./xml.ts";

/**
 * Zeichensatz Standard_E_V2 der ElsterNachricht-Datenarten: Muster von StringZUBaseSType in Eing_sonstNachr-22.xsd und
 * Eing_Vorauszlg-22.xsd (ERiC-Dokumentation 44.3.6.0), dazu Blatt „Zeichensatz“ der Jahresdokumentationen. Typografische
 * Zeichen, die Haben selbst schreibt (Gedankenstrich im Zeitraum, Mittelpunkt im Firmennamen, deutsche Anführungszeichen),
 * fehlen darin; ERiC lehnt sie mit „enthält ein oder mehrere ungültige Zeichen“ ab.
 */
const UNGUELTIG = /[^\n\r\x20-\x7e\xa1-\xa3\xa5\xa7\xaa-\xac\xae-\xb3\xb5\xb9-\xbb\xbf-\xffŒœŠšŸŽž€]/u;

const ERSATZ: Record<string, string> = {
  "\t": " ",
  " ": " ",
  " ": " ",
  " ": " ",
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

/** Ersetzt typografische Zeichen durch ihre einfache Form; andere Zeichen außerhalb des Zeichensatzes lehnt sie ab. */
export function elsterZeichen(text: string, feld: string): string {
  const ersetzt = [...text].map((zeichen) => ERSATZ[zeichen] ?? zeichen).join("");
  const falsch = UNGUELTIG.exec(ersetzt)?.[0];
  if (falsch) throw new ElsterEingabeError(`${feld}: Das Zeichen „${falsch}“ nimmt ELSTER nicht an.`);
  return ersetzt;
}
