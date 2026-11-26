import { documentEuerEffects, EXPENSE_CATEGORIES, type Cents, type DocumentEuerEffect, type EuerPayment, type ExpenseCategory } from "@haben/core";
import { inArray, sql } from "drizzle-orm";
import { schema, type Db, type Tx } from "../../db/index.ts";
import { splitsByDocument } from "../belege/index.ts";
import { documentTotalsById } from "./euer-belege.ts";

/** Zahlung auf einen Beleg aus Zuordnung, Verrechnung oder Kursdifferenz, älteste zuerst */
type Zahlung = {
  id: string;
  document_id: string;
  paid: Cents;
  reverses_id: string | null;
};

/**
 * Alle Zahlungen der Belege, auch die früherer Jahre: Der Stand vor einer Rate braucht sie, nicht nur das laufende Jahr.
 * Wie das bestehende Journalmodell (#864): Gegenzeilen wirken an a.date, sonst gilt der Bankbuchungstag.
 * § 11 Abs. 2 EStG betrifft das Abflussjahr; spätere Aufhebungen dürfen frühere Zahlungsanteile nicht neu runden.
 * https://www.gesetze-im-internet.de/estg/__11.html
 */
function zahlungshistorie(q: Db | Tx, ids: string[]): Promise<Zahlung[]> {
  return q.execute<Zahlung>(sql`
    select id, document_id, paid, reverses_id from (
      select a.id, a.document_id, -a.amount as paid, a.reverses_id, coalesce(a.date, b.booking_date) as datum, a.created_at
        from allocations a join bank_transactions b on b.id = a.transaction_id
       where ${inArray(sql`a.document_id`, ids)} and a.kind = 'document'
      union all
      select id, document_id, -amount, reverses_id, date, created_at from document_settlements
       where ${inArray(schema.documentSettlements.documentId, ids)}
      union all
      select id, document_id, -amount, reverses_id, date, created_at from write_offs
       where ${inArray(schema.writeOffs.documentId, ids)} and kind = 'kursdifferenz'
    ) zahlungen order by datum, created_at, id`);
}

export interface BelegZahlungen {
  /** Je Zahlungs-ID die gerundete Wirkung, für Teilabzüge über alle Zahlungen fortgeschrieben */
  effects: Map<string, DocumentEuerEffect>;
  /** Je Zahlungs-ID der Zahlbetrag aller früheren Zahlungen des Belegs; damit rundet documentEuer kumuliert */
  standVorher: Map<string, Cents>;
}

/**
 * Wirkungen und Zahlstand der Belege, ohne Speicherung. Gelesen werden ausschließlich vorhandene Zuordnungen,
 * Verrechnungen und Kursdifferenzen; Skonto ist keine EÜR-Zahlung. Der Stand vorher zählt auch Zahlungen früherer
 * Jahre mit, sonst würde die erste Rate eines Jahres wieder für sich gerundet.
 */
export async function belegZahlungen(q: Db | Tx, ids: string[]): Promise<BelegZahlungen> {
  const effects = new Map<string, DocumentEuerEffect>();
  const standVorher = new Map<string, Cents>();
  if (ids.length === 0) return { effects, standVorher };
  const { totals, reverseCharge, selbstGeschuldet } = await documentTotalsById(ids, q);
  const history = await zahlungshistorie(q, ids);
  const stand = new Map<string, Cents>();
  for (const zahlung of history) {
    // Eine Gegenzeile dreht die ursprüngliche Wirkung exakt um; kumuliert gerundet werden nur echte Raten.
    if (zahlung.reverses_id === null) standVorher.set(zahlung.id, stand.get(zahlung.document_id) ?? 0);
    stand.set(zahlung.document_id, (stand.get(zahlung.document_id) ?? 0) + zahlung.paid);
  }
  // Kumuliert gerechnet wird nur für Belege mit Teilabzug: Dort rundet jede Zahlung sonst für sich (paidTaxShares).
  const partial = ids.filter((id) => totals.get(id)?.taxes.some((t) => (t.vorsteuerAnteil ?? 0) > 0 && (t.vorsteuerAnteil ?? 10_000) < 10_000));
  if (partial.length === 0) return { effects, standVorher };
  const d = schema.documents;
  const docs = await q.select({ id: d.id, category: d.category, privateShare: d.privateShare }).from(d).where(inArray(d.id, partial));
  const splits = await splitsByDocument(partial, q);
  for (const doc of docs) {
    const lines = splits.get(doc.id)?.map((line) => (reverseCharge.has(doc.id) ? { ...line, tax: 0 } : line));
    const payment: Extract<EuerPayment, { kind: "document" }> = {
      kind: "document",
      date: "",
      paid: 0,
      totals: totals.get(doc.id)!,
      privateShare: doc.privateShare,
      category: doc.category && doc.category in EXPENSE_CATEGORIES ? (doc.category as ExpenseCategory) : "sonstiges",
      ...(lines ? { splits: lines } : {}),
      ...(selbstGeschuldet.has(doc.id) ? { selbstGeschuldet: selbstGeschuldet.get(doc.id)! } : {}),
    };
    const events = history.filter((h) => h.document_id === doc.id).map((h) => ({ id: h.id, paid: h.paid, reversesId: h.reverses_id }));
    for (const [id, effect] of documentEuerEffects(payment, events)) effects.set(id, effect);
  }
  return { effects, standVorher };
}
