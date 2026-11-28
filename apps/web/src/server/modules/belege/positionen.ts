import {
  belegPrivat,
  einzigeKontierung,
  positionenAusSaetzen,
  PRIVATENTNAHME,
  type BasisPoints,
  type Cents,
  type ExpenseCategory,
  type Privatteil,
  type Prozent,
} from "@haben/core";
import { asc, eq, inArray } from "drizzle-orm";
import { db, schema, type Db, type Tx } from "../../db/index.ts";
import { UserError } from "../../errors.ts";

/*
 * Positionen eines Belegs (#1975, docs/adr/belege-positionen.md). Jeder neue oder offene Beleg trägt seine Kontierung nur
 * in document_splits: Kategorie, eigenes Konto, Satz, Netto und Steuer je Position, ein Privatanteil als Position
 * `privatentnahme`. `documents.category`, `own_account_id` und `private_share` bleiben für diese Belege leer bzw. 0.
 *
 * Festgeschriebene Belege aus der Zeit davor haben keine Zeilen und sind gesperrt und versiegelt; ihnen lässt sich nichts
 * hinzufügen. Diese Datei liest sie als eine Position je Satz mit Kategorie und eigenem Konto des Belegs. Ihr Privatanteil
 * bleibt der Prozentsatz am Beleg (`privatteil`): Teilzahlungen runden ihn anders als eine Entnahmezeile, und ein
 * gebuchter Beleg rechnet weiter wie gebucht. Alle Leser nehmen die Positionen von hier, keiner liest die Kategorie am
 * Beleg selbst.
 */

export type DocumentSplit = typeof schema.documentSplits.$inferSelect;

/** Eine Position, wie die Leser sie brauchen; beim Altbestand ohne gespeicherte Zeile */
export type Belegposition = Pick<DocumentSplit, "position" | "category" | "ownAccountId" | "taxRate" | "net" | "tax" | "description" | "originalNet">;

type Altbeleg = Pick<typeof schema.documents.$inferSelect, "category" | "ownAccountId">;
type Satzbetrag = { taxRate: BasisPoints; net: Cents; tax: Cents; originalNet?: Cents | null };

const absteigend = <T extends { taxRate: number }>(amounts: readonly T[]) => [...amounts].sort((a, b) => b.taxRate - a.taxRate);

/**
 * Positionen aus der früheren Form: Kategorie und eigenes Konto am Beleg, ein Privatanteil wird eine Entnahme je Satz.
 * Bei Fremdwährung (`fremd`) teilt sie auch das Netto laut Beleg (originalNet der Beträge).
 */
export function positionenAusBeleg(beleg: Altbeleg & { privateShare: Prozent; fremd: boolean }, amounts: readonly Satzbetrag[]): Belegposition[] {
  const saetze = absteigend(amounts).map((a) => ({ ...a, originalNet: beleg.fremd ? (a.originalNet ?? 0) : null }));
  return positionenAusSaetzen(beleg.category as ExpenseCategory | null, beleg.privateShare, saetze).map((zeile, i) => ({
    ...zeile,
    originalNet: beleg.fremd ? (zeile.originalNet ?? 0) : null,
    position: i + 1,
    ownAccountId: zeile.category === PRIVATENTNAHME ? null : beleg.ownAccountId,
    description: "",
  }));
}

/** Ein festgeschriebener Beleg ohne Zeilen: eine Position je Satz in Euro, der Privatanteil bleibt am Beleg (`privatteil`) */
function altbestand(beleg: Altbeleg, amounts: readonly Satzbetrag[]): Belegposition[] {
  return positionenAusBeleg({ ...beleg, privateShare: 0, fremd: false }, amounts);
}

const zeileOhneKennung = ({ id: _id, documentId: _documentId, ...position }: DocumentSplit): Belegposition => position;

/** Positionen mehrerer Belege, je Beleg in Reihenfolge; ein Beleg ohne Zeilen als Altbestand (siehe oben) */
export async function positionenJeBeleg(ids: readonly string[], q: Db | Tx = db): Promise<Map<string, Belegposition[]>> {
  const eindeutig = [...new Set(ids)];
  const result = new Map<string, Belegposition[]>();
  if (eindeutig.length === 0) return result;
  const zeilen = await q
    .select()
    .from(schema.documentSplits)
    .where(inArray(schema.documentSplits.documentId, eindeutig))
    .orderBy(asc(schema.documentSplits.documentId), asc(schema.documentSplits.position));
  for (const zeile of zeilen) result.set(zeile.documentId, [...(result.get(zeile.documentId) ?? []), zeileOhneKennung(zeile)]);
  const ohne = eindeutig.filter((id) => !result.has(id));
  if (ohne.length === 0) return result;
  const d = schema.documents;
  const belege = await q.select({ id: d.id, category: d.category, ownAccountId: d.ownAccountId }).from(d).where(inArray(d.id, ohne));
  const betraege = await q.select().from(schema.documentAmounts).where(inArray(schema.documentAmounts.documentId, ohne));
  for (const beleg of belege) {
    result.set(
      beleg.id,
      altbestand(
        beleg,
        betraege.filter((a) => a.documentId === beleg.id),
      ),
    );
  }
  return result;
}

/** Positionen eines Belegs, wie positionenJeBeleg */
export async function loadPositionen(id: string, q: Db | Tx = db): Promise<Belegposition[]> {
  return (await positionenJeBeleg([id], q)).get(id) ?? [];
}

/** Ob der Beleg gespeicherte Positionen hat; ohne ist er Altbestand aus der Zeit vor den Positionen */
export async function hatGespeichertePositionen(id: string, q: Db | Tx = db): Promise<boolean> {
  const [zeile] = await q.select({ id: schema.documentSplits.id }).from(schema.documentSplits).where(eq(schema.documentSplits.documentId, id)).limit(1);
  return Boolean(zeile);
}

/**
 * Die eine betriebliche Kontierung (Kategorie und eigenes Konto) neben Entnahmen; null bei mehreren. Ein solcher Beleg
 * bucht und rechnet wie früher ein Beleg mit einer Kategorie, sonst wie eine Aufteilung.
 */
export function einzigePosition<P extends Pick<Belegposition, "category" | "ownAccountId">>(positionen: readonly P[]): P | null {
  return einzigeKontierung(positionen, (p) => `${p.category ?? ""}|${p.ownAccountId ?? ""}`);
}

/** Die Kategorie des Belegs: die seiner einen Kontierung, sonst null (mehrere Kategorien oder keine zugeordnet) */
export function belegKategorie(positionen: readonly Pick<Belegposition, "category" | "ownAccountId">[]): ExpenseCategory | null {
  return (einzigePosition(positionen)?.category as ExpenseCategory | null | undefined) ?? null;
}

/** Ob eine Position eine Entnahme ist */
export const istEntnahme = (p: Pick<Belegposition, "category">) => p.category === PRIVATENTNAHME;

/**
 * Der private Teil des Belegs für Buchung und Prüfung: Netto und Steuer seiner Entnahmen je Satz, beim Altbestand der
 * Prozentsatz am Beleg. Ein Beleg mit Positionen hat dort immer 0.
 */
export function privatteil(beleg: { privateShare: Prozent }, positionen: readonly Belegposition[]): Privatteil {
  if (!positionen.some(istEntnahme)) return beleg.privateShare;
  return belegPrivat(
    0,
    positionen.map((p) => ({ category: p.category ?? "", taxRate: p.taxRate, net: p.net, tax: p.tax })),
  ).entnahme;
}

/** Höchstwert der int4-Spalten net und tax */
const MAX_SPLIT_CENTS = 2_147_483_647;

/** Eine Position zum Speichern, mit ihrem Anteil an der Steuer des Satzes */
export type NeuePosition = Omit<Belegposition, "position">;

/** Ersetzt die Positionen eines offenen Belegs; die Steuer je Position steht schon fest */
export async function schreibePositionen(tx: Tx, documentId: string, positionen: readonly NeuePosition[]): Promise<void> {
  await tx.delete(schema.documentSplits).where(eq(schema.documentSplits.documentId, documentId));
  if (positionen.length === 0) return;
  // Netto und Steuer stehen in int4-Spalten; die Eingabe erlaubt wie bei den Beträgen mehr
  if (positionen.some((p) => Math.abs(p.net) > MAX_SPLIT_CENTS || Math.abs(p.tax) > MAX_SPLIT_CENTS)) {
    throw new UserError("Ein Betrag der Positionen ist zu groß. Stimmen die Nettobeträge?");
  }
  await tx.insert(schema.documentSplits).values(positionen.map((p, i) => ({ ...p, documentId, position: i + 1 })));
}

/** Schreibt die Positionen eines offenen Belegs aus der früheren Form (positionenAusBeleg): Kategorie, Konto, Privatanteil */
export async function schreibePositionenAusBeleg(
  tx: Tx,
  documentId: string,
  beleg: Altbeleg & { privateShare: Prozent; fremd: boolean },
  amounts: readonly Satzbetrag[],
): Promise<void> {
  await schreibePositionen(tx, documentId, ohnePlatz(positionenAusBeleg(beleg, amounts)));
}

/** Positionen ohne ihre Nummer, zum neu Schreiben in derselben Reihenfolge */
export const ohnePlatz = (positionen: readonly Belegposition[]): NeuePosition[] => positionen.map(({ position: _position, ...p }) => p);
