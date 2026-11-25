import {
  amountError,
  type Beschaeftigungsart,
  type BasisPoints,
  type Cents,
  formatDecimal,
  formatHundredths,
  isValidIban,
  type Konfession,
  parseEuro,
  parsePercent,
} from "@haben/core";
import type { FieldErrors } from "../lib/use-submit-check.ts";

/*
 * Stammdaten eines Mitarbeiters für die Lohnabrechnung und ihre Prüfung vor dem Speichern (#1277). Beträge in Euro, Sätze in
 * Prozent, Faktor und Kinderfreibeträge mit Komma; gespeichert wird in Cent, Basispunkten und Tausendsteln. Die Grenzen sind
 * die von `employeeSchema` (server/modules/lohn/employees.ts); nur die Prüfziffer der Steuer-ID prüft allein der Server.
 */

export interface MitarbeiterWerte {
  vorname: string;
  nachname: string;
  strasse: string;
  plz: string;
  ort: string;
  geburtsdatum: string;
  steuerId: string;
  steuerklasse: number;
  faktor: number;
  kinderfreibetraege: number;
  konfession: Konfession | null;
  art: Beschaeftigungsart;
  monatsgehalt: number;
  krankenversicherung: "gesetzlich" | "privat";
  krankenkasse: string;
  krankenkasseBetriebsnummer: string;
  zusatzbeitrag: number;
  pkvBasisbeitrag: number;
  pkvZuschuss: number;
  kinderlosenzuschlag: boolean;
  kinderUnter25: number;
  u1Satz: number | null;
  u2Satz: number;
  rvBefreit: boolean;
  pauschsteuer: boolean;
  personengruppe: string;
  beitragsgruppen: string;
  taetigkeitsschluessel: string;
  svNummer: string;
  statusfeststellung: "" | "beantragt" | "versicherungsfrei" | "versicherungspflichtig";
  eintritt: string;
  austritt: string | null;
  iban: string;
}

export const NEUER_MITARBEITER: MitarbeiterWerte = {
  vorname: "",
  nachname: "",
  strasse: "",
  plz: "",
  ort: "",
  geburtsdatum: "",
  steuerId: "",
  steuerklasse: 1,
  faktor: 1000,
  kinderfreibetraege: 0,
  konfession: null,
  art: "ggf",
  monatsgehalt: 0,
  krankenversicherung: "gesetzlich",
  krankenkasse: "",
  krankenkasseBetriebsnummer: "",
  zusatzbeitrag: 290,
  pkvBasisbeitrag: 0,
  pkvZuschuss: 0,
  kinderlosenzuschlag: false,
  kinderUnter25: 0,
  u1Satz: null,
  u2Satz: 0,
  rvBefreit: false,
  pauschsteuer: true,
  personengruppe: "",
  beitragsgruppen: "",
  taetigkeitsschluessel: "",
  svNummer: "",
  statusfeststellung: "",
  eintritt: "",
  austritt: null,
  iban: "",
};

/** Tausendstel mit Komma: 500 → „0,5“, 950 → „0,95“ */
const alsZahl = (tausendstel: number) => (tausendstel / 1000).toLocaleString("de-DE", { maximumFractionDigits: 3 });

/** „0,5“ → 500 ohne Gleitkomma; null, wenn es keine Zahl mit höchstens drei Nachkommastellen ist */
export function parseTausendstel(text: string): number | null {
  const m = /^(\d+)(?:,(\d{1,3}))?$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0"));
}

/** Felder, die als Text bearbeitet und erst beim Speichern gelesen werden */
export type Texte = Record<
  "monatsgehalt" | "zusatzbeitrag" | "pkvBasisbeitrag" | "pkvZuschuss" | "u1Satz" | "u2Satz" | "faktor" | "kinderfreibetraege" | "kinderUnter25",
  string
>;

export function texte(w: MitarbeiterWerte): Texte {
  return {
    monatsgehalt: w.monatsgehalt ? formatDecimal(w.monatsgehalt) : "",
    zusatzbeitrag: formatHundredths(w.zusatzbeitrag),
    pkvBasisbeitrag: formatDecimal(w.pkvBasisbeitrag),
    pkvZuschuss: formatDecimal(w.pkvZuschuss),
    u1Satz: w.u1Satz === null ? "" : formatHundredths(w.u1Satz),
    u2Satz: formatHundredths(w.u2Satz),
    faktor: alsZahl(w.faktor),
    kinderfreibetraege: alsZahl(w.kinderfreibetraege),
    kinderUnter25: String(w.kinderUnter25),
  };
}

/** Felder mit eigener Meldung, Schlüssel für useSubmitCheck */
export type MitarbeiterFeld =
  | "vorname"
  | "nachname"
  | "geburtsdatum"
  | "iban"
  | "monatsgehalt"
  | "eintritt"
  | "austritt"
  | "steuerId"
  | "faktor"
  | "kinderfreibetraege"
  | "zusatzbeitrag"
  | "pkvBasisbeitrag"
  | "pkvZuschuss"
  | "kinderUnter25"
  | "kinderlosenzuschlag"
  | "krankenkasseBetriebsnummer"
  | "u1Satz"
  | "u2Satz"
  | "svNummer"
  | "personengruppe"
  | "beitragsgruppen"
  | "taetigkeitsschluessel";

/** Höchstbetrag wie `cents` im Schema des Servers */
const HOECHSTBETRAG: Cents = 10_000_000_00;
const HOECHSTSATZ: BasisPoints = 10_000;

/** Ein gelesener Wert und seine Meldung; ungültig bleibt der bisherige Wert stehen */
type Gelesen<T> = { wert: T; fehler: string | null };

/** Lesen eines Texts: null heißt „keine gültige Eingabe“ */
function lesen<T>(wert: T | null, bisher: T, meldung: string): Gelesen<T> {
  return wert === null ? { wert: bisher, fehler: meldung } : { wert, fehler: null };
}

function monatsgehaltLesen(text: string, bisher: Cents): Gelesen<Cents> {
  const cents = parseEuro(text);
  if (cents === null) return { wert: bisher, fehler: amountError() };
  if (cents <= 0 || cents > HOECHSTBETRAG) return { wert: bisher, fehler: amountError(`einen Betrag über 0 bis ${formatDecimal(HOECHSTBETRAG)}`) };
  return { wert: cents, fehler: null };
}

/** Beitrag, der leer bleiben darf (leer ist 0) */
function beitragLesen(text: string, bisher: Cents): Gelesen<Cents> {
  if (text.trim() === "") return { wert: 0, fehler: null };
  const cents = parseEuro(text);
  if (cents === null) return { wert: bisher, fehler: amountError("den Betrag", undefined, { optional: true }) };
  const gueltig = cents >= 0 && cents <= HOECHSTBETRAG;
  return lesen(gueltig ? cents : null, bisher, amountError(`einen Betrag von 0 bis ${formatDecimal(HOECHSTBETRAG)}`, undefined, { optional: true }));
}

/** Satz in Prozent von 0 bis 100 wie jedes Prozentfeld (parsePercent); leer ist 0, beim U1-Satz „keine Teilnahme“ */
function satzLesen<T extends BasisPoints | null>(text: string, bisher: T, beispiel: string, leer: T): Gelesen<T> {
  if (text.trim() === "") return { wert: leer, fehler: null };
  const satz = parsePercent(text);
  const oderLeer = leer === null ? ", oder lass das Feld leer" : "";
  return lesen(satz !== null && satz <= HOECHSTSATZ ? (satz as T) : null, bisher, `Trag einen Satz von 0 bis 100 Prozent ein, etwa ${beispiel}${oderLeer}.`);
}

/** Text aus Ziffern fester Länge (Schlüssel der Sozialversicherung) oder leer */
function ziffern(text: string, anzahl: number, meldung: string): string | null {
  const t = text.trim();
  return t === "" || new RegExp(`^\\d{${anzahl}}$`).test(t) ? null : meldung;
}

/** Nur was zu sehen ist, meldet sich; ein ausgeblendetes Feld behält seinen Wert, wenn der Text nicht lesbar ist */
const nurSichtbar = <T>(sichtbar: boolean, g: Gelesen<T>): Gelesen<T> => (sichtbar ? g : { ...g, fehler: null });

/** Die Felder, die als Text bearbeitet werden: Zahl und Meldung je Feld */
function zahlenLesen(w: MitarbeiterWerte, t: Texte) {
  const gesetzlich = w.krankenversicherung === "gesetzlich";
  const kasse = w.art === "beschaeftigt";
  const kinderUnter25 = t.kinderUnter25.trim();
  const kinder = kinderUnter25 === "" ? 0 : /^\d+$/.test(kinderUnter25) && Number(kinderUnter25) <= 20 ? Number(kinderUnter25) : null;
  const freibetraege = parseTausendstel(t.kinderfreibetraege);
  const faktor = parseTausendstel(t.faktor);
  return {
    monatsgehalt: monatsgehaltLesen(t.monatsgehalt, w.monatsgehalt),
    zusatzbeitrag: nurSichtbar(gesetzlich, satzLesen(t.zusatzbeitrag, w.zusatzbeitrag, "2,9", 0)),
    pkvBasisbeitrag: nurSichtbar(!gesetzlich, beitragLesen(t.pkvBasisbeitrag, w.pkvBasisbeitrag)),
    pkvZuschuss: nurSichtbar(!gesetzlich, beitragLesen(t.pkvZuschuss, w.pkvZuschuss)),
    // Im Minijob nur die Teilnahme (Kästchen), die Sätze sind die der Minijob-Zentrale
    u1Satz: kasse ? satzLesen<BasisPoints | null>(t.u1Satz, w.u1Satz, "1,6", null) : { wert: w.u1Satz, fehler: null },
    u2Satz: nurSichtbar(kasse, satzLesen(t.u2Satz, w.u2Satz, "0,44", 0)),
    // Einen Faktor gibt es nur in Steuerklasse IV; sonst nimmt der Server nur 1,000 an
    faktor:
      w.steuerklasse === 4
        ? lesen(faktor !== null && faktor >= 1 && faktor <= 1000 ? faktor : null, w.faktor, "Trag einen Faktor über 0 bis 1 ein, etwa 0,950.")
        : { wert: 1000, fehler: null },
    kinderfreibetraege: lesen(
      freibetraege !== null && freibetraege <= 20_000 && freibetraege % 500 === 0 ? freibetraege : null,
      w.kinderfreibetraege,
      "Trag eine Zahl von 0 bis 20 in Schritten von 0,5 ein, etwa 1,5.",
    ),
    kinderUnter25: lesen(kinder, w.kinderUnter25, "Trag eine ganze Zahl von 0 bis 20 ein."),
  };
}

/** Meldungen der Felder, die als Text in den Werten stehen */
function angabenPruefen(w: MitarbeiterWerte, kinderUnter25: number): FieldErrors<Exclude<MitarbeiterFeld, keyof Texte>> {
  const mitSv = w.art !== "ggf";
  const kasse = w.art === "beschaeftigt";
  const minijob = w.art === "minijob";
  const steuerId = w.steuerId.trim();
  const svNummer = w.svNummer.trim().toUpperCase();
  return {
    vorname: w.vorname.trim() ? null : "Trag den Vornamen ein.",
    nachname: w.nachname.trim() ? null : "Trag den Nachnamen ein.",
    geburtsdatum: w.geburtsdatum ? null : "Wähle das Geburtsdatum.",
    iban: w.iban.trim() === "" || isValidIban(w.iban) ? null : "Trag eine gültige IBAN ein, oder lass das Feld leer.",
    eintritt: w.eintritt ? null : "Wähle den Tag des Eintritts.",
    austritt: w.austritt && w.eintritt && w.austritt < w.eintritt ? "Wähle einen Tag ab dem Eintritt." : null,
    steuerId: steuerId === "" || /^[1-9]\d{10}$/.test(steuerId) ? null : "Trag eine gültige Steuer-ID mit 11 Ziffern ein, oder lass das Feld leer.",
    kinderlosenzuschlag: w.kinderlosenzuschlag && kinderUnter25 > 0 ? "Mit Kindern unter 25 fällt kein Zuschlag für Kinderlose an." : null,
    krankenkasseBetriebsnummer: kasse ? ziffern(w.krankenkasseBetriebsnummer, 8, "Trag die Betriebsnummer mit 8 Ziffern ein, oder lass das Feld leer.") : null,
    svNummer:
      mitSv && svNummer !== "" && !/^\d{8}[A-Z]\d{3}$/.test(svNummer)
        ? "Trag die Versicherungsnummer mit 12 Stellen ein (8 Ziffern, Buchstabe, 3 Ziffern), oder lass das Feld leer."
        : null,
    personengruppe: mitSv
      ? ziffern(w.personengruppe, 3, `Trag den Schlüssel mit 3 Ziffern ein, etwa ${minijob ? "109" : "101"}, oder lass das Feld leer.`)
      : null,
    beitragsgruppen: mitSv
      ? ziffern(w.beitragsgruppen, 4, `Trag den Schlüssel mit 4 Ziffern ein, etwa ${minijob ? "6500" : "1111"}, oder lass das Feld leer.`)
      : null,
    taetigkeitsschluessel: mitSv ? ziffern(w.taetigkeitsschluessel, 9, "Trag den Schlüssel mit 9 Ziffern ein, oder lass das Feld leer.") : null,
  };
}

/**
 * Werte aus den Texten und je Feld die Meldung für useSubmitCheck, null heißt „stimmt“. Gemeldet wird nur, was zu sehen ist;
 * ein ausgeblendetes Feld behält seinen Wert.
 */
export function auswerten(w: MitarbeiterWerte, t: Texte): { werte: MitarbeiterWerte; fehler: FieldErrors<MitarbeiterFeld> } {
  const zahlen = zahlenLesen(w, t);
  const werte = Object.fromEntries(Object.entries(zahlen).map(([key, g]) => [key, g.wert])) as Pick<MitarbeiterWerte, keyof Texte>;
  const zahlenFehler = Object.fromEntries(Object.entries(zahlen).map(([key, g]) => [key, g.fehler])) as FieldErrors<keyof Texte>;
  return { werte: { ...w, ...werte }, fehler: { ...angabenPruefen(w, werte.kinderUnter25), ...zahlenFehler } };
}
