import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { likePattern, numberRank, unaccentIlike } from "../../../lib/search.ts";
import { db, schema } from "../../db/index.ts";
import { firstHits, runSearchParts, searchPart } from "../../db/search-parts.ts";

/* Kontakte suchen: Schnellsuche und Befehlspalette (#617) sowie der Filter der Kontaktliste */

export interface ContactHit {
  id: string;
  name: string;
  kundennummer: string | null;
  lieferantennummer: string | null;
  ort: string;
  isCustomer: boolean;
  isSupplier: boolean;
}

/** Kontakte als Teil der gemeinsamen Abfrage der Stammdaten (#617): Name, Kunden- oder Lieferantennummer, ohne archivierte */
export function contactsPart(query: string | { id: string }, limit = 5) {
  const contacts = schema.contacts;
  return searchPart(
    {
      id: contacts.id,
      name: contacts.name,
      kundennummer: contacts.kundennummer,
      lieferantennummer: contacts.lieferantennummer,
      ort: contacts.ort,
      isCustomer: contacts.isCustomer,
      isSupplier: contacts.isSupplier,
    },
    (fields) =>
      db
        .select(fields)
        .from(contacts)
        .where(and(isNull(contacts.archivedAt), typeof query === "string" ? contactSearchFilter(query) : eq(contacts.id, query.id)))
        .orderBy(
          ...(typeof query === "string" ? [sql`least(${numberRank(contacts.kundennummer, query)}, ${numberRank(contacts.lieferantennummer, query)})`] : []),
          asc(contacts.name),
        )
        .limit(limit + 1),
    (rows): { hits: ContactHit[]; more: boolean } => firstHits(rows, limit),
  );
}

/** Ein Kontakt für „Zuletzt angesehen“ in der Befehlspalette */
export async function searchContacts(query: string | { id: string }, limit = 5): Promise<{ hits: ContactHit[]; more: boolean }> {
  return (await runSearchParts({ contacts: contactsPart(query, limit) })).contacts;
}

/** Suche über Name, Nummern, E-Mail, Ort, USt-IdNr. und Ansprechpartner; listFields nimmt für die Kontaktliste Telefon und PLZ dazu */
export function contactSearchFilter(query: string, listFields = false) {
  const contacts = schema.contacts;
  const persons = schema.contactPersons;
  const pattern = likePattern(query);
  return or(
    unaccentIlike(contacts.name, pattern),
    unaccentIlike(contacts.kundennummer, pattern),
    unaccentIlike(contacts.lieferantennummer, pattern),
    unaccentIlike(contacts.email, pattern),
    unaccentIlike(contacts.ort, pattern),
    unaccentIlike(contacts.ustId, pattern),
    unaccentIlike(sql`${contacts.debitorNr}::text`, pattern),
    unaccentIlike(sql`${contacts.kreditorNr}::text`, pattern),
    /^\d{4,}$/.test(query) ? unaccentIlike(contacts.iban, `%${query}`) : undefined,
    inArray(
      contacts.id,
      db
        .select({ id: persons.contactId })
        .from(persons)
        .where(or(unaccentIlike(persons.name, pattern), unaccentIlike(persons.email, pattern))),
    ),
    listFields ? unaccentIlike(contacts.telefon, pattern) : undefined,
    listFields ? unaccentIlike(contacts.plz, pattern) : undefined,
  );
}
