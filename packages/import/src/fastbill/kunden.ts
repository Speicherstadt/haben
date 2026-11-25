import { normalizeTelefon, parsePersonenkonto, telefonProblem } from "@haben/core";
import { fbPersonName } from "./map.ts";
import type { FbContact, FbCustomer } from "./types.ts";

/*
 * Weitere Angaben der Kunden (#1939): Telefon, Leitweg-ID und DATEV-Debitor aus customer.get, Ansprechpartner aus
 * contact.get (https://apidocs.fastbill.com/fastbill/de/customer.html, contact.html). Übernommen wird nur, was die Prüfung
 * des Kontaktformulars bestünde; der Rest steht in `problems`, damit der Abruf es nennt, statt es still zu verlieren.
 */

/** Wie im Kontaktformular (contactSchema): höchstens 46 Zeichen */
const MAX_LEITWEG_ID = 46;

const text = (value: string | number | null | undefined) => (value == null ? "" : String(value).trim());

/** Telefon, sonst Mobiltelefon; leer, wenn die Nummer die Prüfung nicht besteht */
function telefon(c: { PHONE?: string | null; MOBILE?: string | null }): { telefon: string; problem: string | null } {
  const raw = text(c.PHONE) || text(c.MOBILE);
  const problem = telefonProblem(raw);
  return problem ? { telefon: "", problem } : { telefon: normalizeTelefon(raw), problem: null };
}

export interface FbCustomerDetails {
  telefon: string;
  leitwegId: string;
  debitorNr: number | null;
  /** Angaben, die Haben nicht übernimmt, mit Grund */
  problems: string[];
}

export function mapFbCustomerDetails(c: FbCustomer): FbCustomerDetails {
  const problems: string[] = [];
  const phone = telefon(c);
  if (phone.problem) problems.push(phone.problem);
  let leitwegId = text(c.BUYER_REFERENCE);
  if (leitwegId.length > MAX_LEITWEG_ID) {
    problems.push(`Leitweg-ID: höchstens ${MAX_LEITWEG_ID} Zeichen`);
    leitwegId = "";
  }
  const debitor = parsePersonenkonto("debitor", text(c.CUSTOMER_ACCOUNT));
  if (!debitor.ok) problems.push(debitor.error);
  return { telefon: phone.telefon, leitwegId, debitorNr: debitor.ok ? debitor.value : null, problems };
}

export interface FbContactPersonMapped {
  /** CUSTOMER_ID des Kunden, an dem die Person hängt */
  customerId: string;
  name: string;
  email: string;
  telefon: string;
  funktion: string;
}

/** Ansprechpartner; null ohne Kunden oder ohne Namen. Ein ungültiges Telefon bleibt weg. */
export function mapFbContactPerson(c: FbContact): FbContactPersonMapped | null {
  const customerId = text(c.CUSTOMER_ID);
  const name = fbPersonName(c.FIRST_NAME, c.LAST_NAME) || text(c.ORGANIZATION);
  if (!customerId || customerId === "0" || !name) return null;
  return { customerId, name, email: text(c.EMAIL), telefon: telefon(c).telefon, funktion: text(c.POSITION) };
}
