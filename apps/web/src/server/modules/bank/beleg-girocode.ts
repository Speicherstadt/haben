import { sepaText, skontoOffer, type Cents } from "@haben/core";
import { girocodeSvg } from "@haben/einvoice";
import { transferCandidates, ueberweisung } from "./sepa-transfers.ts";

/** Ein GiroCode zur Wahl: über den offenen Betrag oder, solange eine Skontofrist läuft, abzüglich Skonto */
export interface GirocodeVariante {
  amount: Cents;
  /** Verwendungszweck wie in der SEPA-Datei, im SEPA-Zeichensatz */
  remittance: string;
  /** QR-Code als SVG */
  svg: string;
  skonto: { percent: number; amount: Cents; until: string } | null;
}

/** GiroCode am Beleg (#1967): Empfänger und IBAN zum Gegenlesen, je Variante ein Code; ohne Code der Grund */
export interface BelegGirocode {
  open: Cents;
  name: string;
  iban: string | null;
  problem: string | null;
  /** Das Problem behebt man im Kontakt des Lieferanten (IBAN fehlt oder ist dort ungültig): Link zum Kontakt */
  problemImKontakt: boolean;
  varianten: GirocodeVariante[];
}

/** Längen der Felder im GiroCode (EPC069-12): Name 70, unstrukturierter Verwendungszweck 140 Zeichen */
const NAME_LENGTH = 70;
const REMITTANCE_LENGTH = 140;

/**
 * GiroCode für einen offenen Beleg, aus denselben Angaben wie die Sammelüberweisung (transferCandidates): offener Rest,
 * geltende IBAN (#410), Verwendungszweck und Skonto zum Stichtag. null, wenn der Beleg nicht über die Bank offen ist
 * (ungebucht, storniert, bezahlt, privat oder bar bezahlt). Gebucht oder vermerkt wird nichts.
 */
export async function belegGirocode(documentId: string, datum: string): Promise<BelegGirocode | null> {
  const [c] = await transferCandidates([documentId]);
  if (!c) return null;
  const name = sepaText(c.supplierName, NAME_LENGTH);
  const base = { open: c.open, name, iban: c.iban, problemImKontakt: c.problemImKontakt };
  if (c.problem || !c.iban) return { ...base, problem: c.problem ?? "IBAN fehlt", varianten: [] };
  const iban = c.iban;
  const offer = c.documentDate ? skontoOffer(c.skontoTerms, c.documentDate, datum, c.open) : null;
  const skontos = [null, ...(offer ? [{ percent: offer.term.percent, amount: offer.amount, until: offer.until }] : [])];
  const varianten = skontos.flatMap((skonto) => {
    const { amount, remittance: zweck } = ueberweisung(c, skonto);
    const remittance = sepaText(zweck, REMITTANCE_LENGTH);
    const svg = girocodeSvg({ name, iban, amount, text: remittance });
    return svg ? [{ amount, remittance, svg, skonto }] : [];
  });
  // girocodePayload prüft dieselben Grenzen wie die SEPA-Datei; passt trotzdem etwas nicht, lieber kein Code als ein falscher
  if (varianten.length === 0) return { ...base, problem: "Aus diesen Angaben lässt sich kein GiroCode erzeugen", varianten: [] };
  return { ...base, problem: null, varianten };
}
