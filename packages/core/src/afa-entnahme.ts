import { ASSET_ACCOUNTS } from "./afa.ts";
import { taxOf, type Cents } from "./money.ts";
import { ACCOUNTS, type Kontenrahmen, type PostingLine } from "./posting.ts";

/*
 * Abgang einer Anlage als Entnahme ins Privatvermögen (#1970), nur im Einzelunternehmen (in GmbH und UG wäre es eine
 * verdeckte Gewinnausschüttung, die Haben nicht abbildet).
 *
 * Umsatzsteuer: Die Entnahme steht einer Lieferung gegen Entgelt gleich, wenn der Gegenstand zum vollen oder teilweisen
 * Vorsteuerabzug berechtigt hat (§ 3 Abs. 1b Satz 1 Nr. 1 und Satz 2 UStG), sonst ist sie nicht steuerbar. Bemessung ist
 * der Einkaufspreis im Zeitpunkt der Entnahme (§ 10 Abs. 4 Satz 1 Nr. 1 UStG, UStAE 10.6 Abs. 1). Als Kleinunternehmer
 * steuerfrei nach § 19 Abs. 1 UStG (Kz 48), im Gesamtumsatz bleibt sie außer Ansatz (UStAE 19.2 Abs. 4).
 *
 * EÜR: Entnahme mit dem Teilwert (§ 6 Abs. 1 Nr. 4 Satz 1 EStG) in Zeile 19 „Veräußerung oder Entnahme von
 * Anlagevermögen“, die Umsatzsteuer darauf in Zeile 17 (Anleitung zur EÜR 2025). Haben nimmt für beides denselben
 * Entnahmewert, bei gebrauchten beweglichen Gegenständen in der Regel derselbe Betrag.
 *
 * Buchung: Privatentnahme an „Erlöse aus Verkäufen Sachanlagevermögen“ (DATEV-Kontenrahmen 2026; Entscheidung im Issue),
 * Buchgewinn, wenn der Entnahmewert mindestens den Restbuchwert erreicht.
 */

export interface AssetWithdrawal {
  /** Entnahmewert netto: Einkaufspreis bzw. Teilwert im Zeitpunkt der Entnahme */
  value: Cents;
  /** Beim Kauf Vorsteuer gezogen (ganz oder teilweise) */
  inputVat: boolean;
}

/** steuerpflichtig: 19 % in Kz 81; kleinunternehmer: steuerfrei in Kz 48; nichtSteuerbar: ohne Vorsteuer beim Kauf */
export type EntnahmeSteuer = "steuerpflichtig" | "kleinunternehmer" | "nichtSteuerbar";

export interface EntnahmeUmsatz {
  steuer: EntnahmeSteuer;
  /** Bemessungsgrundlage für Kz 81 bzw. Kz 48; 0, wenn nicht steuerbar */
  base: Cents;
  vat: Cents;
}

/** Umsatzsteuer der Entnahme; `kleinunternehmer` ist der Stand im Monat der Entnahme. Bewegliche Anlagen: 19 % */
export function entnahmeUmsatz(withdrawal: AssetWithdrawal, kleinunternehmer: boolean): EntnahmeUmsatz {
  if (!withdrawal.inputVat) return { steuer: "nichtSteuerbar", base: 0, vat: 0 };
  if (kleinunternehmer) return { steuer: "kleinunternehmer", base: withdrawal.value, vat: 0 };
  return { steuer: "steuerpflichtig", base: withdrawal.value, vat: taxOf(withdrawal.value, 1900) };
}

const buchgewinn = (value: Cents, restbuchwert: Cents) => value >= restbuchwert;

/** Konto des Restbuchwerts: bei einer Entnahme mit Buchgewinn 2315 bzw. 4855, sonst 2310 bzw. 6895 wie bisher */
export function restbuchwertKonto(kontenrahmen: Kontenrahmen, withdrawal: AssetWithdrawal | null, restbuchwert: Cents): string {
  const konten = ASSET_ACCOUNTS[kontenrahmen];
  return withdrawal && buchgewinn(withdrawal.value, restbuchwert) ? konten.restbuchwertGewinn : konten.restbuchwert;
}

/** Erlöskonto der Entnahme nach Umsatzsteuer und Buchgewinn bzw. -verlust */
function entnahmeKonto(kontenrahmen: Kontenrahmen, mitUst: boolean, gewinn: boolean): string {
  const konten = ASSET_ACCOUNTS[kontenrahmen].entnahme;
  if (mitUst) return gewinn ? konten.mitUstGewinn : konten.mitUstVerlust;
  return gewinn ? konten.ohneUstGewinn : konten.ohneUstVerlust;
}

/** Buchung zum Abgangsdatum: Privatentnahmen an Erlöskonto und Umsatzsteuer; leer bei einem Entnahmewert von 0 */
export function entnahmePosting(umsatz: EntnahmeUmsatz, value: Cents, restbuchwert: Cents, kontenrahmen: Kontenrahmen): PostingLine[] {
  const accounts = ACCOUNTS[kontenrahmen];
  const mitUst = umsatz.steuer === "steuerpflichtig";
  const lines: PostingLine[] = [
    { account: accounts.privatentnahmen, debit: value + umsatz.vat, credit: 0, taxCode: null },
    { account: entnahmeKonto(kontenrahmen, mitUst, buchgewinn(value, restbuchwert)), debit: 0, credit: value, taxCode: mitUst ? "USt19" : null },
    { account: accounts.ust[1900], debit: 0, credit: umsatz.vat, taxCode: "USt19" },
  ];
  return lines.filter((line) => line.debit !== 0 || line.credit !== 0);
}
