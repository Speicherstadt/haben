import { arbeitskostenAnteil } from "@haben/core";
import type { Texts } from "./i18n.ts";
import type { InvoiceDocument } from "./types.ts";

/**
 * Anteil der Arbeits-, Maschinen- und Fahrtkosten als Satz unter den Summen und im XML (BT-22), sobald eine Position das
 * Kennzeichen trägt (#712); sonst null. Den Betrag rechnet arbeitskostenAnteil aus @haben/core. In der Schlussrechnung
 * nennt der Satz den Anteil der ganzen Leistung, die Abschlagsrechnungen tragen ihren eigenen.
 */
export function arbeitskostenHinweis(doc: Pick<InvoiceDocument, "lines" | "priceMode" | "discount" | "taxTreatment">, t: Texts): string | null {
  const amount = arbeitskostenAnteil(doc.lines, doc.priceMode ?? "netto", doc.discount ?? null);
  if (amount === null) return null;
  const inclVat = (doc.taxTreatment ?? "regulaer") === "regulaer" && doc.lines.some((line) => line.arbeitskosten && line.taxRate > 0);
  return t.arbeitskosten(
    t.money(amount),
    inclVat,
    doc.lines.some((line) => line.deductionOf),
  );
}

/** Steuerhinweis unter den Summen, danach der Satz zum Anteil; ohne gekennzeichnete Position bleibt er wie bisher, das Blatt bitgenau gleich */
export function mitArbeitskostenHinweis(note: string | null, doc: Parameters<typeof arbeitskostenHinweis>[0], t: Texts): string | null {
  const hinweis = arbeitskostenHinweis(doc, t);
  return hinweis ? [note, hinweis].filter(Boolean).join("\n") : note;
}
