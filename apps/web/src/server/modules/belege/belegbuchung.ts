import {
  assetAccount,
  documentPosting,
  documentSplitPosting,
  type ExpenseCategory,
  type Kontenrahmen,
  type PostingLine,
  type Rechtsform,
  vorsteuerWartetAufAusfuehrung,
} from "@haben/core";
import type { schema } from "../../db/index.ts";
import { belegKategorie, einzigePosition, privatteil, type Belegposition } from "./positionen.ts";
import { splitLines } from "./splits.ts";

/*
 * Buchungszeilen eines Belegs: beim Buchen und beim Storno (Gegenbuchung im heutigen Format, wenn es auf jedem Konto
 * dasselbe ergibt, docs/adr/journal-als-quelle.md). Die Beträge kommen je Satz vom Beleg, nicht nachgerechnet: die Steuer
 * steht auf der Rechnung.
 */

type Document = typeof schema.documents.$inferSelect;
type Amount = { taxRate: number; net: number; tax: number; vorsteuerAnteil?: number | null };

/** Bei § 13b zahlst du nur netto; die Steuer geht ans Finanzamt, nicht an den Lieferanten */
export function totalsOf(amounts: Amount[], reverseCharge: string | null = null) {
  const net = amounts.reduce((s, a) => s + a.net, 0);
  const tax = amounts.reduce((s, a) => s + a.tax, 0);
  return { net, tax, gross: reverseCharge ? net : net + tax };
}

export function belegSummen(doc: Pick<Document, "reverseCharge">, amounts: Amount[]) {
  return {
    ...totalsOf(amounts, doc.reverseCharge),
    taxes: [...amounts].sort((a, b) => b.taxRate - a.taxRate).map((a) => ({ rate: a.taxRate, base: a.net, tax: a.tax, vorsteuerAnteil: a.vorsteuerAnteil })),
  };
}

/**
 * Die Leistung ist beim Buchen noch nicht ausgeführt (#693): Die Vorsteuer kommt auf das Zwischenkonto und wird im Monat
 * der Ausführung frei, bei Zahlung vorher mit der Zahlung (umsatzsteuer/vorsteuer-freigabe.ts). Nur über die Bank: bar
 * und privat ist der Beleg mit der Buchung bezahlt, da gäbe es kein Ereignis, das sie nachzieht. Welche Belege
 * überhaupt warten, sagt vorsteuerWartetAufAusfuehrung.
 */
export function leistungNochNichtAusgefuehrt(doc: Document, positionen: readonly Belegposition[]): boolean {
  return (
    doc.payment === "bank" &&
    vorsteuerWartetAufAusfuehrung({
      belegdatum: doc.documentDate,
      leistungVon: doc.serviceFrom,
      leistungBis: doc.serviceTo,
      reverseCharge: doc.reverseCharge,
      category: belegKategorie(positionen),
      gross: doc.gross,
      erstattetBezahltes: doc.erstattetBezahltes,
    })
  );
}

/**
 * Die Zeilen der Belegbuchung aus den Positionen (#1975); `vorsteuerAbzug` wie am Beleg festgehalten (Kleinunternehmer
 * ziehen keine Vorsteuer ab). Eine betriebliche Kontierung neben Entnahmen bucht wie ein Beleg mit einer Kategorie
 * (documentPosting), auch für Anlagen, Einfuhrumsatzsteuer und Erwerb; mehrere wie eine Aufteilung (documentSplitPosting).
 */
export function belegZeilen(
  doc: Document,
  amounts: Amount[],
  positionen: readonly Belegposition[],
  books: { kontenrahmen: Kontenrahmen; rechtsform: Rechtsform },
  vorsteuerAbzug: boolean | number,
  /** Eigene Sachkonten (#270): ID → Nummer; eine Position mit eigenem Konto bucht dort statt auf das Konto der Kategorie */
  eigene: ReadonlyMap<string, string> = new Map(),
): PostingLine[] {
  const totals = belegSummen(doc, amounts);
  const eine = einzigePosition(positionen);
  const spaeter = leistungNochNichtAusgefuehrt(doc, positionen);
  if (!eine) {
    return documentSplitPosting(
      totals,
      splitLines(positionen, eigene),
      books.kontenrahmen,
      books.rechtsform,
      doc.payment,
      vorsteuerAbzug,
      // ig_erwerb lehnt splitBookingIssues mit Aufteilung ab; § 13b (#508) bucht je Zeile mit RC13bEU bzw. RC13bDrittland
      doc.reverseCharge === "eu" || doc.reverseCharge === "drittland" ? doc.reverseCharge : null,
      // Gutschrift, die bereits Bezahltes erstattet: Vorsteuerminderung erst mit dem Ausgleich (#786)
      doc.erstattetBezahltes,
      // Leistung beim Buchen noch nicht ausgeführt: Vorsteuer auf das Zwischenkonto bis zur Freigabe oder Zahlung (#693)
      spaeter,
    );
  }
  // Anlage: auf das Anlagekonto statt in den Aufwand; ohne Vorsteuerabzug gehört die Steuer zu den Anschaffungskosten
  const asset = eine.category === "anlage" ? doc.asset : null;
  const eigenesKonto = eine.ownAccountId ? eigene.get(eine.ownAccountId) : undefined;
  return documentPosting(
    totals,
    eine.category as ExpenseCategory,
    books.kontenrahmen,
    books.rechtsform,
    doc.payment,
    vorsteuerAbzug,
    asset ? assetAccount(asset.kind, asset.method, books.kontenrahmen) : eigenesKonto,
    privatteil(doc, positionen),
    doc.reverseCharge,
    doc.erstattetBezahltes,
    spaeter,
  );
}
