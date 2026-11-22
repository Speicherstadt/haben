import { arbeitskostenAnteil } from "@haben/core";
import type { Texts } from "./i18n.ts";
import type { InvoiceDocument } from "./types.ts";

/**
 * Anteil der Arbeits-, Maschinen- und Fahrtkosten als Satz unter den Summen und im XML (BT-22), sobald eine Position das
 * Kennzeichen trägt (#712); sonst null. Den Betrag rechnet arbeitskostenAnteil aus @haben/core. In der Schlussrechnung
 * nennt der Satz den Anteil der ganzen Leistung, die Abschlagsrechnungen tragen ihren eigenen. Nennt jede abgezogene
 * Abschlagsrechnung einen Anteil, sagt ein zweiter Satz, wie viel davon auf sie und wie viel auf die Schlussrechnung
 * entfällt (#1667). Sonst wäre die Zahl für die Schlussrechnung zu hoch: Den Abschlag hat der Kunde vielleicht schon im
 * Vorjahr gezahlt (§ 11 Abs. 2 EStG). Liegen die je Abschlag gerundeten Anteile über dem der ganzen Leistung, entfällt der
 * Satz ebenso. Storno und Rechnungskorrektur bleiben beim ersten Satz.
 */
export function arbeitskostenHinweis(
  doc: Pick<InvoiceDocument, "lines" | "priceMode" | "discount" | "taxTreatment"> & Partial<Pick<InvoiceDocument, "kind" | "deducted">>,
  t: Texts,
): string | null {
  const amount = arbeitskostenAnteil(doc.lines, doc.priceMode ?? "netto", doc.discount ?? null);
  if (amount === null) return null;
  const inclVat = (doc.taxTreatment ?? "regulaer") === "regulaer" && doc.lines.some((line) => line.arbeitskosten && line.taxRate > 0);
  const schluss = doc.lines.some((line) => line.deductionOf);
  const satz = t.arbeitskosten(t.money(amount), inclVat, schluss);
  const deducted = doc.deducted ?? [];
  if (!schluss || doc.kind !== "rechnung" || deducted.length === 0 || deducted.some((d) => d.arbeitskosten === undefined)) return satz;
  const abschlaege = deducted.reduce((sum, d) => sum + (d.arbeitskosten ?? 0), 0);
  const rest = amount - abschlaege;
  return rest < 0 ? satz : `${satz} ${t.arbeitskostenRest(t.money(abschlaege), t.money(rest))}`;
}

/** Steuerhinweis unter den Summen, danach der Satz zum Anteil; ohne gekennzeichnete Position bleibt er wie bisher, das Blatt bitgenau gleich */
export function mitArbeitskostenHinweis(note: string | null, doc: Parameters<typeof arbeitskostenHinweis>[0], t: Texts): string | null {
  const hinweis = arbeitskostenHinweis(doc, t);
  return hinweis ? [note, hinweis].filter(Boolean).join("\n") : note;
}
