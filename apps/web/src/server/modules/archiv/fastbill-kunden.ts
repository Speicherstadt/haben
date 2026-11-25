import { type FastbillClient, mapFbContactPerson, mapFbCustomer, mapFbCustomerDetails } from "@haben/import";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { withActor } from "../../db/actor.ts";
import { schema, type Tx } from "../../db/index.ts";
import type { LexofficeImportProgress } from "../../db/schema.ts";
import { contactPersonInputSchema } from "../stammdaten/index.ts";

/*
 * Kunden aus FastBill beim Abruf (fastbill.ts): neu anlegen, über den Namen verknüpfen oder die Rolle ergänzen. Telefon,
 * Leitweg-ID und DATEV-Debitor (#1939) füllen nur leere Felder, damit Werte aus Haben bleiben; was nicht passt, nennt
 * der Abruf in der Liste der fehlgeschlagenen Belege, der Kunde kommt trotzdem. Danach die Ansprechpartner.
 */

type Save = (force?: boolean) => Promise<void>;
type Details = ReturnType<typeof mapFbCustomerDetails>;

/** 1. Kunden; FastBill führt keine Lieferanten als Kontakte */
export async function importFastbillCustomers(actor: string, client: FastbillClient, progress: LexofficeImportProgress, save: Save) {
  for await (const raw of client.customers()) {
    const contact = mapFbCustomer(raw);
    const details = mapFbCustomerDetails(raw);
    const problems = [...details.problems];
    await withActor(actor, async (tx) => {
      const [known] = await tx.select({ id: schema.contacts.id }).from(schema.contacts).where(eq(schema.contacts.fastbillId, contact.fastbillId));
      if (known) {
        await tx
          .update(schema.contacts)
          .set({ isCustomer: true })
          .where(and(eq(schema.contacts.id, known.id), eq(schema.contacts.isCustomer, false)));
        await fillEmpty(tx, known.id, details, problems);
        return;
      }
      const [sameName] = await tx
        .select({ id: schema.contacts.id })
        .from(schema.contacts)
        .where(and(isNull(schema.contacts.fastbillId), sql`lower(${schema.contacts.name}) = lower(${contact.name})`))
        .limit(1);
      if (sameName) {
        await tx.update(schema.contacts).set({ fastbillId: contact.fastbillId, isCustomer: true }).where(eq(schema.contacts.id, sameName.id));
        await fillEmpty(tx, sameName.id, details, problems);
        progress.contactsLinked += 1;
        return;
      }
      const { fastbillId, kundennummer, name, strasse, plz, ort, land, email, ustId } = contact;
      const [created] = await tx
        .insert(schema.contacts)
        .values({ fastbillId, isCustomer: true, isSupplier: false, kundennummer, name, strasse, plz, ort, land, email, ustId })
        .returning({ id: schema.contacts.id });
      await fillEmpty(tx, created!.id, details, problems);
      progress.contacts += 1;
    });
    if (problems.length > 0)
      progress.failed.push({
        lexofficeId: `fastbill/customer/${contact.fastbillId}`,
        number: contact.kundennummer ?? "",
        message: `Kunde übernommen, ohne: ${problems.join("; ")}`,
      });
    await save();
  }
  await importFastbillContactPersons(actor, client, save);
}

/** Telefon, Leitweg-ID und Debitor nur in leere Felder; ein vergebener Debitor bleibt weg und kommt in `problems` */
async function fillEmpty(tx: Tx, contactId: string, details: Details, problems: string[]) {
  const c = schema.contacts;
  if (details.telefon)
    await tx
      .update(c)
      .set({ telefon: details.telefon })
      .where(and(eq(c.id, contactId), eq(c.telefon, "")));
  if (details.leitwegId)
    await tx
      .update(c)
      .set({ leitwegId: details.leitwegId })
      .where(and(eq(c.id, contactId), eq(c.leitwegId, "")));
  if (details.debitorNr === null) return;
  const [taken] = await tx
    .select({ id: c.id })
    .from(c)
    .where(and(eq(c.debitorNr, details.debitorNr), ne(c.id, contactId)))
    .limit(1);
  if (taken) problems.push(`DATEV-Debitor ${details.debitorNr} ist schon an einem anderen Kontakt vergeben`);
  else
    await tx
      .update(c)
      .set({ debitorNr: details.debitorNr })
      .where(and(eq(c.id, contactId), isNull(c.debitorNr)));
}

/**
 * Ansprechpartner am Kunden (#1939). Eine Person, die es am Kontakt mit gleichem Namen schon gibt, kommt nicht doppelt;
 * ohne bekannten Kunden bleibt sie weg. Eine E-Mail, die das Formular ablehnen würde, bleibt leer.
 */
async function importFastbillContactPersons(actor: string, client: FastbillClient, save: Save) {
  for await (const raw of client.contacts()) {
    const person = mapFbContactPerson(raw);
    if (!person) continue;
    await withActor(actor, async (tx) => {
      const [contact] = await tx.select({ id: schema.contacts.id }).from(schema.contacts).where(eq(schema.contacts.fastbillId, person.customerId));
      if (!contact) return;
      const p = schema.contactPersons;
      const [same] = await tx
        .select({ id: p.id })
        .from(p)
        .where(and(eq(p.contactId, contact.id), sql`lower(${p.name}) = lower(${person.name})`))
        .limit(1);
      if (same) return;
      const { customerId: _, ...fields } = person;
      const parsed = contactPersonInputSchema.safeParse(fields);
      const data = parsed.success ? parsed.data : contactPersonInputSchema.safeParse({ ...fields, email: "" }).data;
      if (!data) return;
      await tx.insert(p).values({ ...data, contactId: contact.id, createdBy: actor });
    });
    await save();
  }
}
