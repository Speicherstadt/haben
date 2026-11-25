import { XMLParser } from "fast-xml-parser";
import { findDeep, int, type Node, text } from "./xml-lesen.ts";

/**
 * Rückmeldungen des ELSTER-Annahmeservers aus der gespeicherten Serverantwort. TransferHeader und jeder
 * NutzdatenHeader tragen ein RC mit Rueckgabe (Code, Text) und Stack (Code, Text); Code 0 heißt angenommen.
 * Aufbau nach den Beispielantworten von erica (digitalservicebund, MIT). ERiC meldet bei einem Fehler des
 * Servers nur einen allgemeinen Text zum Rückgabecode; was der Server genau bemängelt, steht erst hier.
 */

export interface ServerRueckmeldung {
  quelle: "Transferheader" | "Nutzdatenheader";
  code: number;
  text: string;
}

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false });

const parse = (xml: string): unknown => {
  if (!xml.trim()) return {};
  try {
    return parser.parse(xml);
  } catch {
    return {};
  }
};

const leerraum = (value: string) => value.replace(/\s+/g, " ").trim();

function ausHeader(header: Node, quelle: ServerRueckmeldung["quelle"]): ServerRueckmeldung[] {
  const rc = findDeep(header, "RC")[0];
  if (!rc) return [];
  const gefunden: ServerRueckmeldung[] = [];
  for (const name of ["Rueckgabe", "Stack"]) {
    const eintrag = findDeep(rc, name)[0];
    const code = eintrag ? int(eintrag.Code) : 0;
    if (!eintrag || code === 0) continue;
    const meldung = leerraum(text(eintrag.Text));
    // Der Stack wiederholt oft den Code der Rückgabe, meist ohne Text; neu ist nur ein anderer Code oder Text.
    // Hatte die Rückgabe den Code ohne Text, bekommt derselbe Eintrag den Text des Stacks
    const vorhanden = gefunden.find((g) => g.code === code && (meldung === "" || g.text === meldung || g.text === ""));
    if (vorhanden) {
      if (vorhanden.text === "") vorhanden.text = meldung;
      continue;
    }
    gefunden.push({ quelle, code, text: meldung });
  }
  return gefunden;
}

/** Fehler im TransferHeader und in den NutzdatenHeadern, in der Reihenfolge der Antwort; leer bei Erfolg oder ohne Antwort */
export function serverRueckmeldungen(serverResponseXml: string): ServerRueckmeldung[] {
  const doc = parse(serverResponseXml);
  return [
    ...findDeep(doc, "TransferHeader").flatMap((header) => ausHeader(header, "Transferheader")),
    ...findDeep(doc, "NutzdatenHeader").flatMap((header) => ausHeader(header, "Nutzdatenheader")),
  ];
}

/**
 * 601015001 ist der allgemeine Code der Verfahrensprüfung; der Text des Annahmeservers benennt, was nicht passt
 * (Kombination aus Verfahren, Datenart und Vorgang, Hersteller-ID). Der Text bleibt stehen, damit der Hinweis zur
 * Ursache führt; ergänzt wird nur im Postfach mit Testmerker ein Satz zur Einordnung (#1791).
 */
const VERFAHRENSPRUEFUNG = 601015001;

/**
 * Was beim Postfach dahintersteckt. Gehört nur zum Postfachweg: In der Voranmeldung und im Belegabruf nennt
 * derselbe Code andere Gründe, dort wäre der Rat falsch (#1791).
 */
const POSTFACH_HINWEIS =
  "Zum Einordnen: Der genannte CN ist das Übertragungszertifikat von ERiC, nicht das eigene. Der Abruf aus der " +
  "Test-Datenbank ist gescheitert; echt abrufen: Haken „Nur Testübermittlung“ ausschalten (braucht die eingetragene " +
  "Hersteller-ID), dann heißt der Knopf „Postfach abrufen“.";

/**
 * 610101210 meldet einen Fehler im Transferheader (ERIC_TRANSFER_ERR_XML_THEADER). Im Testabruf scheitert damit schon
 * der Transferweg, bevor das Postfach angesprochen wird; die Antwort nennt dort keinen CN, deshalb steht hier nur der
 * Weg zum echten Abruf. Der Satz oben bleibt für 601015001, weil er dort die Ursache erklärt (#1791).
 */
const TRANSFERHEADER = 610101210;

const POSTFACH_ABRUF_HINWEIS =
  "Zum Einordnen: Der Abruf aus der Test-Datenbank ist gescheitert; echt abrufen: Haken „Nur Testübermittlung“ " +
  "ausschalten (braucht die eingetragene Hersteller-ID), dann heißt der Knopf „Postfach abrufen“.";

/** Der Rat zum Testabruf je Code; leer, wenn der Code keinen eigenen Satz hat. */
function ratZumTestabruf(code: number): string {
  if (code === VERFAHRENSPRUEFUNG) return POSTFACH_HINWEIS;
  if (code === TRANSFERHEADER) return POSTFACH_ABRUF_HINWEIS;
  return "";
}

/**
 * Die Meldung von ERiC, ergänzt um Code und Text des Servers; unverändert, wenn der Server nichts meldet.
 * `testmerker: true` heißt: Antwort auf eine PostfachAnfrage mit Testmerker; nur dort steht der Rat zum Haken
 * „Nur Testübermittlung“, bei 601015001 mit CN, bei 610101210 ohne. Beim echten Abruf und außerhalb des Postfachs
 * bleibt der Text des Servers stehen.
 */
export function mitServerMeldung(message: string, serverResponseXml: string, testmerker = false): string {
  const meldungen = serverRueckmeldungen(serverResponseXml);
  if (meldungen.length === 0) return message;
  const zeilen = meldungen.map((m) => {
    const rat = testmerker ? ratZumTestabruf(m.code) : "";
    const teile = [m.text, rat].filter((teil) => teil !== "");
    return `${m.quelle} ${m.code}${teile.length > 0 ? ` – ${teile.join(" ")}` : ""}`;
  });
  return `${message} Antwort des ELSTER-Servers: ${zeilen.join("; ")}`;
}
