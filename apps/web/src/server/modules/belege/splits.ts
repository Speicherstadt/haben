import {
  allocateSplitTax,
  EXPENSE_CATEGORY_KEYS,
  PRIVATENTNAHME,
  privatZulaessig,
  splitIssues,
  type AllocatedSplitLine,
  type ExpenseCategory,
  type Rechtsform,
  inCents,
  inBasisPoints,
  type Prozent,
} from "@haben/core";
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Db, type Tx } from "../../db/index.ts";
import { UserError } from "../../errors.ts";

/*
 * Aufteilung eines Belegs auf mehrere Kontierungszeilen (#271). Die Zeilen tragen Kategorie, Steuersatz und Netto; die
 * Vorsteuer des Satzes verteilt allocateSplitTax beim Speichern anteilig auf sie. Ohne Zeilen gilt wie bisher die
 * Kategorie des Belegs. Mit Zeilen steht am Beleg keine Kategorie.
 *
 * Die freie Beschreibung der Zeile (#1975) ist Persistenz- und Anzeigesache: Sie wird gespeichert und mit den Zeilen
 * ausgeliefert, steckt aber nicht in DocumentSplitLine/AllocatedSplitLine. Gebucht, gerechnet und geprüft wird über
 * Konto, Satz und Betrag; splitLines() lässt sie deshalb weg.
 */

export type DocumentSplit = typeof schema.documentSplits.$inferSelect;

export const splitInputSchema = z.object({
  category: z.enum(EXPENSE_CATEGORY_KEYS),
  /** Eigenes Sachkonto (#270) der Kategorie; fehlt = das Konto der Kategorie */
  ownAccountId: z.uuid().nullable().default(null),
  taxRate: inBasisPoints(z.union([z.literal(1900), z.literal(700), z.literal(0)])),
  net: inCents(z.number().int().min(-100_000_000_00).max(100_000_000_00)),
  /** Freie Beschreibung der Zeile (#1975); nicht angegeben oder leer = keine Beschreibung */
  description: z.string().trim().max(200).default(""),
});

/** Höchstwert der int4-Spalten net und tax */
const MAX_SPLIT_CENTS = 2_147_483_647;

export type SplitInput = z.output<typeof splitInputSchema>;

/**
 * Zeilen als Kontierungszeilen für Buchung, EÜR und Prüfung. Mit `eigene` (ID → Nummer, loadOwnAccountNumbers) bucht eine
 * Zeile auf ihr eigenes Sachkonto (#270); ohne gilt das Konto der Kategorie.
 */
export function splitLines(
  splits: (Pick<DocumentSplit, "category" | "taxRate" | "net" | "tax"> & { ownAccountId?: string | null })[],
  eigene: ReadonlyMap<string, string> = new Map(),
): AllocatedSplitLine[] {
  return splits.map(({ category, taxRate, net, tax, ownAccountId }) => {
    const account = ownAccountId ? eigene.get(ownAccountId) : undefined;
    return { category: category as ExpenseCategory, ...(account ? { account } : {}), taxRate, net, tax };
  });
}

/** Ersetzt die Zeilen eines offenen Belegs; die Vorsteuer je Zeile kommt aus den Euro-Beträgen des Belegs je Satz */
export async function replaceSplits(tx: Tx, documentId: string, splits: SplitInput[], amounts: { taxRate: number; net: number; tax: number }[]): Promise<void> {
  await tx.delete(schema.documentSplits).where(eq(schema.documentSplits.documentId, documentId));
  if (splits.length === 0) return;
  // allocateSplitTax bekommt nur, was es rechnet: Kategorie, Satz und Netto. Die Beschreibung (#1975) bleibt hier,
  // sonst trüge sie der Spread in AllocatedSplitLine bis in die Buchungszeile.
  const allocated = allocateSplitTax(
    splits.map(({ category, taxRate, net }) => ({ category, taxRate, net })),
    amounts,
  );
  // Netto und verteilte Vorsteuer stehen in int4-Spalten; die Eingabe erlaubt wie bei den Beträgen mehr
  if (allocated.some((line) => Math.abs(line.net) > MAX_SPLIT_CENTS || Math.abs(line.tax) > MAX_SPLIT_CENTS)) {
    throw new UserError("Ein Betrag der Aufteilung ist zu groß. Stimmen die Nettobeträge der Zeilen?");
  }
  await tx
    .insert(schema.documentSplits)
    .values(allocated.map((line, i) => ({ documentId, position: i + 1, ...line, ownAccountId: splits[i]!.ownAccountId, description: splits[i]!.description })));
}

/**
 * Zeilen eines Belegs für die Anzeige (Belegseite, Duplizieren, Storno): die ganze Zeile samt Beschreibung (#1975). Wer
 * nur buchen will, nimmt splitLines().
 */
export async function loadSplits(documentId: string, q: Db | Tx = db): Promise<DocumentSplit[]> {
  return q.select().from(schema.documentSplits).where(eq(schema.documentSplits.documentId, documentId)).orderBy(asc(schema.documentSplits.position));
}

/** Zeilen mehrerer Belege, je Beleg in Reihenfolge; Belege ohne Aufteilung fehlen. `eigene` wie bei splitLines */
export async function splitsByDocument(
  ids: string[],
  q: Db | Tx = db,
  eigene: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, AllocatedSplitLine[]>> {
  if (ids.length === 0) return new Map();
  const rows = await q
    .select()
    .from(schema.documentSplits)
    .where(inArray(schema.documentSplits.documentId, ids))
    .orderBy(asc(schema.documentSplits.documentId), asc(schema.documentSplits.position));
  const result = new Map<string, AllocatedSplitLine[]>();
  for (const row of rows) result.set(row.documentId, [...(result.get(row.documentId) ?? []), ...splitLines([row], eigene)]);
  return result;
}

/**
 * Was gegen das Buchen eines aufgeteilten Belegs spricht. Belege mit deutscher Umsatzsteuer in Euro und § 13b (EU und
 * Drittland, #508). Innergemeinschaftlicher Erwerb, Privatanteil und Fremdwährung verteilen Steuer bzw. Beträge anders;
 * sie lehnt Haben mit Aufteilung ab.
 */
export function splitBookingIssues(
  doc: { reverseCharge: string | null; privateShare: Prozent; currency: string },
  amounts: { taxRate: number; net: number; tax: number }[],
  splits: Pick<DocumentSplit, "category" | "taxRate" | "net" | "tax">[],
  /** Ohne Angabe wird die Rechtsform nicht geprüft; das Buchen prüft sie in jedem Fall */
  rechtsform?: Rechtsform,
): string[] {
  const issues: string[] = [];
  // Eine Entnahme gibt es nur im Einzelunternehmen; in GmbH und UG ist privat Genutztes Arbeitslohn oder verdeckte
  // Gewinnausschüttung (#1975). Dieselbe Regel wie am Beleg und in der Buchung: privatZulaessig
  if (rechtsform && !privatZulaessig(rechtsform) && splits.some((s) => s.category === PRIVATENTNAHME))
    issues.push("Einen Privatanteil gibt es nur im Einzelunternehmen");
  if (doc.reverseCharge === "ig_erwerb") issues.push("Innergemeinschaftlicher Erwerb mit Aufteilung wird nicht unterstützt");
  // § 13b Abs. 1 und Abs. 2 Nr. 1 UStG: nur sonstige Leistungen und Werklieferungen, wie ohne Aufteilung (bookingIssues)
  else if (doc.reverseCharge && splits.some((s) => s.category === "wareneinkauf")) issues.push("§ 13b gilt nicht für Wareneinkäufe");
  if (doc.privateShare > 0) issues.push("Ein Privatanteil mit Aufteilung wird nicht unterstützt");
  if (doc.currency !== "EUR") issues.push("Fremdwährung mit Aufteilung wird nicht unterstützt");
  return [...issues, ...splitIssues(splitLines(splits), amounts)];
}
