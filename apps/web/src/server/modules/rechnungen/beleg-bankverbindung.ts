import type { Db, Tx } from "../../db/index.ts";
import { bankverbindungProblem, kontaktBankverbindung } from "../stammdaten/index.ts";

/**
 * Bankverbindung eines Rechnungs- oder Angebotsentwurfs beim Speichern (#1887). Gewählt (auch null = Standard) gilt die
 * Wahl. Ohne Angabe, etwa über die API, bei Abo-Rechnungen oder Zeiteinträgen, bleibt die bisherige; ein neuer Entwurf
 * oder ein anderer Kunde bekommt die Vorgabe des Kontakts.
 */
export async function bankverbindungFuerEntwurf(
  tx: Tx,
  gewaehlt: string | null | undefined,
  contactId: string | null,
  bisher: { bankverbindungId: string | null; contactId: string | null } | null,
  fehler: (meldung: string) => Error,
): Promise<string | null> {
  if (gewaehlt !== undefined) {
    const problem = await bankverbindungProblem(tx, gewaehlt, bisher?.bankverbindungId);
    if (problem) throw fehler(problem);
    return gewaehlt;
  }
  if (bisher && bisher.contactId === contactId) return bisher.bankverbindungId;
  return kontaktBankverbindung(tx, contactId);
}

/**
 * Bankverbindung, die eine Kopie oder die Rechnung aus einem Angebot vom Original übernimmt: nur eine aktive; eine
 * archivierte fällt weg (undefined), dann gilt die Vorgabe des Kontakts.
 */
export async function uebernommeneBankverbindung(q: Db | Tx, id: string | null): Promise<string | null | undefined> {
  return (await bankverbindungProblem(q, id)) === null ? id : undefined;
}
