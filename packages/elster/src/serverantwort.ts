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
 * (Kombination aus Verfahren, Datenart und Vorgang, Hersteller-ID). Diese Fälle gibt es außerhalb des Postfachs.
 * Deshalb wird der Text nur ersetzt, wenn er den belegten Zertifikatssatz trägt, und auch dann ohne
 * Handlungsanweisung (#1791).
 */
const VERFAHRENSPRUEFUNG = 601015001;

/** „… ist fuer ihr Client-Zertifikat mit CN: … nicht zugelassen“ – der Satz aus dem belegten Postfach-Fall (#1791) */
const zertifikatssatz = (text: string) => /zertifikat[\s\S]{0,200}?nicht zugelassen/i.test(text);

/** Sagt, was der Code bedeutet, statt den Zertifikatssatz zu wiederholen; keine Handlungsanweisung */
const VERFAHRENSPRUEFUNG_TEXT =
  "Verfahrensprüfung: Diese Kombination aus Verfahren, Datenart und Vorgang ist nicht zugelassen. " +
  "Der Zertifikatssatz der Antwort nennt das Zertifikat des Aufrufers; gemeint ist die Kombination.";

/**
 * Was beim Postfach dahintersteckt. Gehört nur zum Postfachweg: In der Voranmeldung und im Belegabruf nennt
 * derselbe Code andere Gründe, dort wäre der Rat falsch (#1791).
 */
const POSTFACH_HINWEIS =
  "Beim Postfach tritt 601015001 auf, wenn die Anfrage mit Testmerker in die Test-Datenbank geht: " +
  "ELSTER lässt diese Kombination dort nicht zu. Echt abrufen geht mit eigener Hersteller-ID und " +
  "ausgeschaltetem „Nur Testübermittlung“.";

/**
 * Die Meldung von ERiC, ergänzt um Code und Text des Servers; unverändert, wenn der Server nichts meldet.
 * `postfach` sagt, dass die Antwort zu einer PostfachAnfrage gehört; nur dort steht der Rat zum Testmerker.
 */
export function mitServerMeldung(message: string, serverResponseXml: string, postfach = false): string {
  const meldungen = serverRueckmeldungen(serverResponseXml);
  if (meldungen.length === 0) return message;
  const zeilen = meldungen.map((m) => {
    const verdeckt = m.code === VERFAHRENSPRUEFUNG && zertifikatssatz(m.text);
    const rat = postfach && m.code === VERFAHRENSPRUEFUNG ? POSTFACH_HINWEIS : "";
    const teile = [verdeckt ? VERFAHRENSPRUEFUNG_TEXT : m.text, rat].filter((teil) => teil !== "");
    return `${m.quelle} ${m.code}${teile.length > 0 ? ` – ${teile.join(" ")}` : ""}`;
  });
  return `${message} Antwort des ELSTER-Servers: ${zeilen.join("; ")}`;
}
