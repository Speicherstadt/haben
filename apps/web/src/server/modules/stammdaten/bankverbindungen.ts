import { compactIban, isValidBic, isValidIban } from "@haben/core";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { withActor } from "../../db/actor.ts";
import { db, schema, type Db, type Tx } from "../../db/index.ts";
import { UserError } from "../../errors.ts";

/*
 * Weitere Bankverbindungen für Rechnungen und Angebote (#1887). Die Standard-Bankverbindung bleibt in den Firmendaten;
 * diese hier wählt man je Beleg oder als Vorgabe am Kontakt. Belege verweisen darauf, darum nur archivieren.
 */

export class BankverbindungError extends UserError {}

export type Bankverbindung = typeof schema.bankverbindungen.$inferSelect;

export const bankverbindungSchema = z.object({
  bezeichnung: z.string().trim().min(1, "Bezeichnung fehlt").max(60),
  iban: z.string().transform(compactIban).refine(isValidIban, "IBAN ist ungültig (Prüfziffer oder Länge)"),
  bic: z
    .string()
    .trim()
    .transform((bic) => bic.toUpperCase())
    .refine((bic) => bic === "" || isValidBic(bic), "BIC hat 8 oder 11 Zeichen"),
  bank: z.string().trim().max(100),
  /** GiroCode erlaubt 70 Zeichen für den Namen (EPC069-12) */
  kontoinhaber: z.string().trim().max(70),
});

export type BankverbindungInput = z.infer<typeof bankverbindungSchema>;

/** Alle, auch archivierte, nach Bezeichnung */
export function listBankverbindungen(q: Db | Tx = db): Promise<Bankverbindung[]> {
  return q.select().from(schema.bankverbindungen).orderBy(asc(schema.bankverbindungen.bezeichnung));
}

export async function loadBankverbindung(q: Db | Tx, id: string | null | undefined): Promise<Bankverbindung | null> {
  if (!id) return null;
  const [row] = await q.select().from(schema.bankverbindungen).where(eq(schema.bankverbindungen.id, id));
  return row ?? null;
}

/** Dieselbe IBAN zweimal wäre in der Auswahl nicht zu unterscheiden; die Standard-Bankverbindung ist schon wählbar */
async function assertNeueIban(tx: Tx, iban: string, id: string | null): Promise<void> {
  const [company] = await tx.select({ iban: schema.company.iban }).from(schema.company);
  if (company && compactIban(company.iban) === iban) {
    throw new BankverbindungError("Diese IBAN ist schon die Standard-Bankverbindung in den Firmendaten.", { felder: ["iban"] });
  }
  const [vorhanden] = await tx.select().from(schema.bankverbindungen).where(eq(schema.bankverbindungen.iban, iban));
  if (vorhanden && vorhanden.id !== id) {
    throw new BankverbindungError(`Diese IBAN steht schon unter „${vorhanden.bezeichnung}“.`, { felder: ["iban"] });
  }
}

export async function createBankverbindung(actor: string, input: BankverbindungInput): Promise<Bankverbindung> {
  return withActor(actor, async (tx) => {
    await assertNeueIban(tx, input.iban, null);
    const [created] = await tx.insert(schema.bankverbindungen).values(input).returning();
    return created!;
  });
}

/** Festgeschriebene Belege behalten ihren Stand (seller); Entwürfe und Kontakte zeigen ab jetzt die neuen Angaben */
export async function updateBankverbindung(actor: string, id: string, input: BankverbindungInput): Promise<void> {
  await withActor(actor, async (tx) => {
    await assertNeueIban(tx, input.iban, id);
    const [updated] = await tx
      .update(schema.bankverbindungen)
      .set(input)
      .where(eq(schema.bankverbindungen.id, id))
      .returning({ id: schema.bankverbindungen.id });
    if (!updated) throw new BankverbindungError("Bankverbindung nicht gefunden.");
  });
}

/** Archiviert: nicht mehr wählbar; Entwürfe und Kontakte, die sie schon gewählt haben, behalten sie */
export async function setBankverbindungArchived(actor: string, id: string, archived: boolean): Promise<void> {
  await withActor(actor, (tx) =>
    tx
      .update(schema.bankverbindungen)
      .set({ archivedAt: archived ? new Date() : null })
      .where(eq(schema.bankverbindungen.id, id)),
  );
}

/**
 * Eine neu gewählte Bankverbindung muss aktiv sein; eine schon gewählte (bisher) bleibt, auch wenn sie inzwischen
 * archiviert ist, wie beim Ansprechpartner.
 */
export async function bankverbindungProblem(q: Db | Tx, id: string | null | undefined, bisher?: string | null): Promise<string | null> {
  if (!id || id === bisher) return null;
  const row = await loadBankverbindung(q, id);
  if (!row) return "Die gewählte Bankverbindung gibt es nicht.";
  if (row.archivedAt) return `Die Bankverbindung „${row.bezeichnung}“ ist archiviert.`;
  return null;
}

/** bankverbindungProblem als Fehler am Feld, für das Kontaktformular */
export async function assertBankverbindungWaehlbar(tx: Tx, id: string | null | undefined, bisher: string | null): Promise<void> {
  const problem = await bankverbindungProblem(tx, id, bisher);
  if (problem) throw new BankverbindungError(problem, { felder: ["bankverbindungId"] });
}

/** Vorgabe am Kontakt für neue Rechnungen und Angebote; null = Standard, auch wenn die Vorgabe inzwischen archiviert ist */
export async function kontaktBankverbindung(q: Db | Tx, contactId: string | null | undefined): Promise<string | null> {
  if (!contactId) return null;
  const [row] = await q
    .select({ id: schema.bankverbindungen.id })
    .from(schema.contacts)
    .innerJoin(schema.bankverbindungen, eq(schema.bankverbindungen.id, schema.contacts.bankverbindungId))
    .where(and(eq(schema.contacts.id, contactId), isNull(schema.bankverbindungen.archivedAt)));
  return row?.id ?? null;
}

/** Für die Auswahl am Kontakt: die weiteren Bankverbindungen und die IBAN des Standards aus den Firmendaten */
export async function bankverbindungAuswahl(q: Db | Tx = db) {
  const [liste, [company]] = await Promise.all([listBankverbindungen(q), q.select({ iban: schema.company.iban }).from(schema.company)]);
  return { liste: liste.map(({ id, bezeichnung, iban, archivedAt }) => ({ id, bezeichnung, iban, archivedAt })), standardIban: company?.iban ?? "" };
}
