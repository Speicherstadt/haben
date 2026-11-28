import { and, asc, eq, sql } from "drizzle-orm";
import { withActor } from "../../db/actor.ts";
import { db, schema, type Tx } from "../../db/index.ts";
import { UserError } from "../../errors.ts";
import { loadFile, sha256Of, sniff, storeFile } from "../../storage.ts";
import { DocumentError, documentFileProblem } from "./documents.ts";

/**
 * Ausgangsrechnungen aus dem Ordner für Ausgangsrechnungen des Postfachs (#660). Der Abruf legt das PDF ab und merkt sich
 * Absender und Betreff; gebucht wird erst, wenn der Nutzer die Angaben geprüft hat (Rechnungen, „Aus dem Postfach“).
 */

export type OutgoingRow = typeof schema.inboxOutgoing.$inferSelect;

/** Legt einen Anhang als wartende Ausgangsrechnung ab; dieselbe Datei ein zweites Mal, auch eine verworfene, ist ein Duplikat */
export async function ablegenAusgang(
  actor: string,
  file: { bytes: Uint8Array; filename: string },
  mail: { sender: string; subject: string; receivedAt: Date | null },
): Promise<{ duplicate: boolean }> {
  const problem = documentFileProblem(file);
  if (problem) throw new DocumentError(problem.message);
  const type = sniff(file.bytes)!;
  if (type.kind !== "pdf") throw new DocumentError(`${file.filename}: Ausgangsrechnungen übernimmt Haben nur als PDF.`);
  const sha256 = sha256Of(file.bytes);
  const [known] = await db.select({ id: schema.inboxOutgoing.id }).from(schema.inboxOutgoing).where(eq(schema.inboxOutgoing.sha256, sha256));
  if (known) return { duplicate: true };
  await storeFile(file.bytes);
  const inserted = await withActor(actor, (tx) =>
    tx
      .insert(schema.inboxOutgoing)
      .values({
        sha256,
        filename: file.filename.slice(0, 200),
        mimeType: type.mimeType,
        size: file.bytes.byteLength,
        sender: mail.sender.slice(0, 500),
        subject: mail.subject.slice(0, 500),
        receivedAt: mail.receivedAt,
      })
      .onConflictDoNothing({ target: schema.inboxOutgoing.sha256 })
      .returning({ id: schema.inboxOutgoing.id }),
  );
  return { duplicate: inserted.length === 0 };
}

/** Wartende Ausgangsrechnungen, die älteste zuerst */
export async function listOutgoing(): Promise<OutgoingRow[]> {
  return db.select().from(schema.inboxOutgoing).where(eq(schema.inboxOutgoing.status, "offen")).orderBy(asc(schema.inboxOutgoing.createdAt));
}

/** Das PDF einer wartenden Ausgangsrechnung für das Übernehmen-Formular */
export async function outgoingFile(id: string): Promise<{ row: OutgoingRow; bytes: Uint8Array }> {
  const [row] = await db
    .select()
    .from(schema.inboxOutgoing)
    .where(and(eq(schema.inboxOutgoing.id, id), eq(schema.inboxOutgoing.status, "offen")));
  if (!row) throw new UserError("Diese Ausgangsrechnung wartet nicht mehr im Postfach.");
  return { row, bytes: new Uint8Array(await loadFile(row.sha256)) };
}

/** Vor dem Buchen: Der Eintrag muss noch warten, sonst entstünde aus derselben Datei eine zweite Rechnung */
export async function assertOutgoingOpen(id: string): Promise<void> {
  await outgoingFile(id);
}

/**
 * Beim Übernehmen: Eintrag erledigt, mit der entstandenen Rechnung. Mit `inTx` in der Transaktion, die bucht: Wartet der
 * Eintrag nicht mehr (etwa gleichzeitig in einem zweiten Fenster übernommen oder verworfen) oder scheitert das Markieren,
 * entsteht auch keine Rechnung.
 */
export async function markOutgoingAdopted(actor: string, id: string, invoiceId: string, inTx?: Tx): Promise<void> {
  const mark = (tx: Tx) =>
    tx
      .update(schema.inboxOutgoing)
      .set({ status: "uebernommen", invoiceId })
      .where(and(eq(schema.inboxOutgoing.id, id), eq(schema.inboxOutgoing.status, "offen")))
      .returning({ id: schema.inboxOutgoing.id });
  const done = inTx ? await mark(inTx) : await withActor(actor, mark);
  if (done.length === 0) throw new UserError("Diese Ausgangsrechnung wartet nicht mehr im Postfach.");
}

/** Verwerfen: Die Datei wird nicht übernommen und vom Abruf nicht wieder angeboten */
export async function discardOutgoing(actor: string, id: string): Promise<void> {
  await withActor(actor, async (tx) => {
    // Erst die Kette im Audit-Log, dann die Zeile: Wer bucht, hält die Kette schon, wenn er den Eintrag markiert
    await tx.execute(sql`select haben_lock_audit_chain()`);
    await tx
      .update(schema.inboxOutgoing)
      .set({ status: "verworfen" })
      .where(and(eq(schema.inboxOutgoing.id, id), eq(schema.inboxOutgoing.status, "offen")));
  });
}
