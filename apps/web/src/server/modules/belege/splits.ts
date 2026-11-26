import {
  allocateSplitTax,
  EXPENSE_CATEGORY_KEYS,
  splitIssues,
  taxOf,
  type AllocatedSplitLine,
  type Cents,
  type ExpenseCategory,
  inCents,
  inBasisPoints,
  inProzent,
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
 * Seit #1914 trägt jede Zeile ihren eigenen Privatanteil (Internet 25 %, Telefon 40 % auf einem Beleg). Fehlt die Angabe,
 * gilt die Vorgabe der Firmendaten für die Kategorie, wie am Beleg ohne Aufteilung; der Anteil des Belegs zählt dann nicht.
 */

export type DocumentSplit = typeof schema.documentSplits.$inferSelect;

export const splitInputSchema = z
  .object({
    category: z.enum(EXPENSE_CATEGORY_KEYS),
    /** Eigenes Sachkonto (#270) der Kategorie; fehlt = das Konto der Kategorie */
    ownAccountId: z.uuid().nullable().default(null),
    taxRate: inBasisPoints(z.union([z.literal(1900), z.literal(700), z.literal(0)])),
    net: inCents(z.number().int().min(-100_000_000_00).max(100_000_000_00)),
    /** Privatanteil dieser Zeile in Prozent (#1914); fehlt er, gilt die Vorgabe der Kategorie aus den Firmendaten */
    privateShare: inProzent(z.number().int().min(0).max(100)).optional(),
    /** Absoluter Privatanteil dieser Zeile in Cent (#1926), etwa Netflix komplett privat; statt privateShare */
    privateAmount: inCents(z.number().int().min(0).max(100_000_000_00)).optional(),
    /** Basis von privateAmount: netto = der Betrag ist netto, brutto = er enthält die Steuer der Zeile */
    privateAmountBasis: z.enum(["netto", "brutto"]).optional(),
  })
  .superRefine((split, ctx) => {
    const amount = split.privateAmount;
    if (amount === undefined) {
      if (split.privateAmountBasis !== undefined)
        ctx.addIssue({ code: "custom", message: "Trag zum Privatbetrag auch den Betrag ein.", path: ["privateAmount"] });
      return;
    }
    if (split.privateAmountBasis === undefined) {
      ctx.addIssue({ code: "custom", message: "Trag zum Privatbetrag auch die Basis an, netto oder brutto.", path: ["privateAmountBasis"] });
      return;
    }
    if ((split.privateShare ?? 0) > 0) {
      ctx.addIssue({
        code: "custom",
        message: "Privatbetrag und Privatanteil in Prozent schließen sich aus; trag nur eines von beidem ein.",
        path: ["privateAmount"],
      });
    }
    // Brutto der Zeile: ihr Netto mit der Steuer ihres Satzes; den genauen Steueranteil verteilt allocateSplitTax erst beim
    // Speichern, deshalb ist das hier die Grenze aus den Eingabewerten der Zeile
    const brutto = split.net + taxOf(split.net, split.taxRate);
    const hoechstens = split.privateAmountBasis === "brutto" ? brutto : split.net;
    if (amount > hoechstens) {
      const was = split.privateAmountBasis === "brutto" ? "Bruttobetrag" : "Nettobetrag";
      ctx.addIssue({ code: "custom", message: `Der Privatbetrag ist größer als der ${was} der Zeile.`, path: ["privateAmount"] });
    }
  });

/** Höchstwert der int4-Spalten net und tax */
const MAX_SPLIT_CENTS = 2_147_483_647;

export type SplitInput = z.output<typeof splitInputSchema>;

/**
 * Zeilen als Kontierungszeilen für Buchung, EÜR und Prüfung. Mit `eigene` (ID → Nummer, loadOwnAccountNumbers) bucht eine
 * Zeile auf ihr eigenes Sachkonto (#270); ohne gilt das Konto der Kategorie.
 */
export function splitLines(
  splits: (Pick<DocumentSplit, "category" | "taxRate" | "net" | "tax"> & {
    ownAccountId?: string | null;
    privateShare?: Prozent;
    privateAmount?: Cents | null;
    privateAmountBasis?: "netto" | "brutto" | null;
  })[],
  eigene: ReadonlyMap<string, string> = new Map(),
): AllocatedSplitLine[] {
  return splits.map(({ category, taxRate, net, tax, ownAccountId, privateShare, privateAmount, privateAmountBasis }) => {
    const account = ownAccountId ? eigene.get(ownAccountId) : undefined;
    return {
      category: category as ExpenseCategory,
      ...(account ? { account } : {}),
      taxRate,
      net,
      tax,
      privateShare: privateShare ?? 0,
      privateAmount: privateAmount ?? null,
      privateAmountBasis: privateAmountBasis ?? null,
    };
  });
}

/**
 * Ersetzt die Zeilen eines offenen Belegs; die Vorsteuer je Zeile kommt aus den Euro-Beträgen des Belegs je Satz.
 * `vorgaben` sind die Privatanteile der Firmendaten je Kategorie (#1914): Fehlt der Anteil einer Zeile, gilt die Vorgabe.
 */
export async function replaceSplits(
  tx: Tx,
  documentId: string,
  splits: SplitInput[],
  amounts: { taxRate: number; net: number; tax: number }[],
  vorgaben: Readonly<Record<string, Prozent>> = {},
): Promise<void> {
  await tx.delete(schema.documentSplits).where(eq(schema.documentSplits.documentId, documentId));
  if (splits.length === 0) return;
  const allocated = allocateSplitTax(splits, amounts);
  // Netto und verteilte Vorsteuer stehen in int4-Spalten; die Eingabe erlaubt wie bei den Beträgen mehr
  if (allocated.some((line) => Math.abs(line.net) > MAX_SPLIT_CENTS || Math.abs(line.tax) > MAX_SPLIT_CENTS)) {
    throw new UserError("Ein Betrag der Aufteilung ist zu groß. Stimmen die Nettobeträge der Zeilen?");
  }
  await tx.insert(schema.documentSplits).values(
    allocated.map((line, i) => ({
      documentId,
      position: i + 1,
      ...line,
      ownAccountId: splits[i]!.ownAccountId,
      // Ein Betrag schließt den Prozentwert aus (#1926); die Vorgabe der Kategorie gilt nur, wenn die Zeile keinen Betrag trägt
      privateShare: splits[i]!.privateAmount != null ? 0 : (splits[i]!.privateShare ?? vorgaben[splits[i]!.category] ?? 0),
      privateAmount: splits[i]!.privateAmount ?? null,
      privateAmountBasis: splits[i]!.privateAmountBasis ?? null,
    })),
  );
}

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
 * Drittland, #508). Innergemeinschaftlicher Erwerb und Fremdwährung verteilen Steuer bzw. Beträge anders; sie lehnt Haben
 * mit Aufteilung ab. Den Privatanteil trägt seit #1914 jede Zeile selbst; dass es ihn nur im Einzelunternehmen gibt, prüft
 * documents.ts mit der Rechtsform.
 */
export function splitBookingIssues(
  doc: { reverseCharge: string | null; currency: string },
  amounts: { taxRate: number; net: number; tax: number }[],
  splits: Pick<DocumentSplit, "category" | "taxRate" | "net" | "tax">[],
): string[] {
  const issues: string[] = [];
  if (doc.reverseCharge === "ig_erwerb") issues.push("Innergemeinschaftlicher Erwerb mit Aufteilung wird nicht unterstützt");
  // § 13b Abs. 1 und Abs. 2 Nr. 1 UStG: nur sonstige Leistungen und Werklieferungen, wie ohne Aufteilung (bookingIssues)
  else if (doc.reverseCharge && splits.some((s) => s.category === "wareneinkauf")) issues.push("§ 13b gilt nicht für Wareneinkäufe");
  if (doc.currency !== "EUR") issues.push("Fremdwährung mit Aufteilung wird nicht unterstützt");
  return [...issues, ...splitIssues(splitLines(splits), amounts)];
}
