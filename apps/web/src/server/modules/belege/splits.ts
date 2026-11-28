import {
  EXPENSE_CATEGORIES,
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
import { z } from "zod";
import { einzigePosition, istEntnahme, type Belegposition } from "./positionen.ts";

/*
 * Eingabe und Prüfung der Positionen eines Belegs (#271, #1975). Die Positionen tragen Kategorie, Steuersatz und Netto;
 * die Steuer des Satzes verteilt allocateSplitTax beim Speichern anteilig auf sie (beleg-eingabe.ts). Lesen und Schreiben stehen in
 * positionen.ts.
 *
 * Die freie Beschreibung der Position (#1975) ist Persistenz- und Anzeigesache: Sie wird gespeichert und mit den
 * Positionen ausgeliefert, steckt aber nicht in DocumentSplitLine/AllocatedSplitLine. Gebucht, gerechnet und geprüft wird
 * über Konto, Satz und Betrag; splitLines() lässt sie deshalb weg.
 */

export const splitInputSchema = z.object({
  category: z.enum(EXPENSE_CATEGORY_KEYS),
  /** Eigenes Sachkonto (#270) der Kategorie; fehlt = das Konto der Kategorie */
  ownAccountId: z.uuid().nullable().default(null),
  taxRate: inBasisPoints(z.union([z.literal(1900), z.literal(700), z.literal(0)])),
  net: inCents(z.number().int().min(-100_000_000_00).max(100_000_000_00)),
  /** Freie Beschreibung der Zeile (#1975); nicht angegeben oder leer = keine Beschreibung */
  description: z.string().trim().max(200).default(""),
});

export type SplitInput = z.output<typeof splitInputSchema>;

/**
 * Zeilen als Kontierungszeilen für Buchung, EÜR und Prüfung. Mit `eigene` (ID → Nummer, loadOwnAccountNumbers) bucht eine
 * Zeile auf ihr eigenes Sachkonto (#270); ohne gilt das Konto der Kategorie.
 */
export function splitLines(
  splits: readonly (Pick<Belegposition, "category" | "taxRate" | "net" | "tax"> & { ownAccountId?: string | null })[],
  eigene: ReadonlyMap<string, string> = new Map(),
): AllocatedSplitLine[] {
  return splits.map(({ category, taxRate, net, tax, ownAccountId }) => {
    const account = ownAccountId ? eigene.get(ownAccountId) : undefined;
    return { category: category as ExpenseCategory, ...(account ? { account } : {}), taxRate, net, tax };
  });
}

/**
 * Was gegen das Buchen eines aufgeteilten Belegs spricht. Belege mit deutscher Umsatzsteuer in Euro und § 13b (EU und
 * Drittland, #508). Innergemeinschaftlicher Erwerb, Privatanteil und Fremdwährung verteilen Steuer bzw. Beträge anders;
 * sie lehnt Haben mit Aufteilung ab.
 */
export function splitBookingIssues(
  doc: { reverseCharge: string | null; privateShare: Prozent; currency: string },
  amounts: { taxRate: number; net: number; tax: number }[],
  splits: readonly Pick<Belegposition, "category" | "taxRate" | "net" | "tax">[],
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

/**
 * Kontierung für Auswertungen, die zwischen einer Kategorie und einer Aufteilung rechnen (EÜR-Nebenbücher, #1975): Eine
 * Kategorie mit einer Position je Satz und ohne Entnahme rechnet wie früher ein Beleg ohne Aufteilung, mit dem
 * Privatanteil in Prozent am Beleg (Altbestand); alles andere über die Positionen als Zeilen (`splits`). Ohne Kategorie
 * gilt „sonstiges“ wie bisher.
 */
export function auswertungsKontierung(
  positionen: readonly Belegposition[],
  eigene: ReadonlyMap<string, string> = new Map(),
): { category: ExpenseCategory; splits?: AllocatedSplitLine[] } {
  const eine = einzigePosition(positionen);
  const jeSatzEine = new Set(positionen.map((p) => p.taxRate)).size === positionen.length;
  const kategorie = eine?.category && eine.category in EXPENSE_CATEGORIES ? (eine.category as ExpenseCategory) : "sonstiges";
  if (eine && jeSatzEine && !positionen.some(istEntnahme)) return { category: kategorie };
  return { category: kategorie, splits: splitLines(positionen, eigene) };
}
