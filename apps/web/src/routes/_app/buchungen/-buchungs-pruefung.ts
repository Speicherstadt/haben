import {
  amountError,
  freieBuchungFindings,
  isKapitalgesellschaft,
  type ManualField,
  type ManualFinding,
  type ManualKind,
  type ManualLine,
  manualPostingFindings,
  parseEuro,
} from "@haben/core";
import type { Row } from "./-buchungs-zeile.tsx";
import type { Data } from "./neu.tsx";

/*
 * Prüfung der manuellen Buchung beim Buchen (#1277): Was an einer Zeile liegt (Konto, Betrag, Steuerschlüssel), steht an
 * deren Feld, unter dem Schlüssel `<key der Zeile>.<feld>`; was die ganze Buchung betrifft (Soll und Haben ungleich, eine
 * Seite fehlt), steht als Liste unter der Tabelle. Die Regeln selbst kommen aus manualPostingFindings und
 * freieBuchungFindings in @haben/core, dieselben, mit denen der Server prüft.
 */

/** Felder einer Zeile in der Reihenfolge der Zellen; danach sucht der Fokus das erste mit Fehler */
export const ZEILEN_FELDER: readonly ManualField[] = ["account", "debit", "credit", "taxCode"];

/** Beispiel in der Meldung eines Betrags, der sich nicht lesen lässt */
const BEISPIEL = 10_000;

const SEITE: Record<"debit" | "credit", string> = { debit: "Soll", credit: "Haben" };

/** Namenseingaben ohne Auswahl zählen als leeres Konto und brauchen einen Hinweis zur Auswahl. */
export function kontoSuchfehler(rows: readonly Row[]): ManualFinding[] {
  return rows.flatMap((r, row) =>
    r.accountText.trim() !== "" && r.account.trim() === ""
      ? [{ text: "Konto nicht gefunden; aus der Liste wählen oder die Nummer eingeben", row, field: "account" as const }]
      : [],
  );
}

/**
 * Alle Meldungen zur Buchung, wie der Server prüft (createManualEntry): Freie Buchung im Einzelunternehmen immer, in GmbH
 * und UG nur mit Steuerschlüssel. Die Kontosuche zuerst: Ihr Hinweis passt zu einer Namenseingabe ohne Auswahl besser als
 * „Konto hat vier Ziffern“.
 */
export function buchungsMeldungen(rows: readonly Row[], lines: readonly ManualLine[], data: Data, kind: ManualKind): ManualFinding[] {
  const frei = kind === "umbuchung" && (!isKapitalgesellschaft(data.rechtsform) || lines.some((l) => l.taxCode));
  return [
    ...kontoSuchfehler(rows),
    ...manualPostingFindings(lines, data.kontenrahmen, data.rechtsform, kind),
    ...(frei ? freieBuchungFindings(lines, { kontenrahmen: data.kontenrahmen, rechtsform: data.rechtsform, kleinunternehmer: data.kleinunternehmer }) : []),
  ];
}

/** Schlüssel eines Felds für useSubmitCheck */
export const zellenSchluessel = (rowKey: number, field: ManualField) => `${rowKey}.${field}`;

const satz = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** Fehler eines Felds: ein nicht lesbarer Betrag mit amountError, sonst die erste Meldung der Prüfung für dieses Feld */
function zellenFehler(row: Row, index: number, field: ManualField, findings: readonly ManualFinding[]): string | null {
  if (field === "debit" || field === "credit") {
    const text = row[field];
    if (text.trim() !== "" && parseEuro(text) === null) return amountError(`den Betrag im ${SEITE[field]}`, BEISPIEL, { optional: true });
  }
  const finding = findings.find((f) => f.row === index && f.field === field);
  return finding ? satz(finding.text) : null;
}

/**
 * Fehler je Feld der Zeilen und die Meldungen zur ganzen Buchung. Die Meldungen zur ganzen Buchung zählen erst, wenn die
 * Zeilen stimmen: Solange etwa ein Betrag nicht lesbar ist, wären „Soll und Haben sind nicht gleich“ und „Es fehlt eine
 * Seite“ nur Folgen davon.
 */
export function buchungsFehler(rows: readonly Row[], findings: readonly ManualFinding[]) {
  const zellen = Object.fromEntries(
    rows.flatMap((row, index) => ZEILEN_FELDER.map((field) => [zellenSchluessel(row.key, field), zellenFehler(row, index, field, findings)] as const)),
  );
  const zeilenOffen = Object.values(zellen).some((e) => e !== null);
  const buchung = zeilenOffen ? [] : findings.filter((f) => f.row === undefined).map((f) => satz(f.text));
  return { zellen, buchung };
}
