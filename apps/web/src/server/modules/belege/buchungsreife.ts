import {
  ELEKTRO_NUR_EINZELUNTERNEHMEN,
  einfuhrumsatzsteuerIssues,
  elektroAvailable,
  VOLLER_ABZUG,
  assetIssues,
  formatRateMonth,
  maxDegressiveRate,
  normalizeUstId,
  privatZulaessig,
  rateMonth,
  satzIssues,
  taxOf,
  usesUsefulLife,
  ustIdAufbauProblem,
  ustIdProblem,
  type AssetKind,
  type AssetMethod,
  type Cents,
  type Rechtsform,
} from "@haben/core";
import type { Tx } from "../../db/index.ts";
import { periodReported } from "../buchhaltung/index.ts";
import { documentOwnAccountProblems } from "../eigene-konten/index.ts";
import type { Company } from "../stammdaten/index.ts";
import { today } from "../../today.ts";
import { totalsOf } from "./belegbuchung.ts";
import { DocumentError, type Document, type DocumentAmount, type DocumentInput } from "./documents.ts";
import { belegKategorie, einzigePosition, istEntnahme, privatteil, type Belegposition } from "./positionen.ts";
import { splitBookingIssues, splitLines } from "./splits.ts";

/*
 * Was vor dem Buchen eines Belegs fehlt (aus documents.ts). Geprüft wird über die Positionen (#1975): Eine betriebliche
 * Kontierung neben Entnahmen wie ein Beleg mit einer Kategorie, mehrere wie eine Aufteilung.
 */

/**
 * Warum „erstattet bereits Bezahltes“ an diesem Beleg nicht geht; null = in Ordnung. Die Angabe sagt, was die Gutschrift
 * mindert, und wird ausdrücklich gesetzt, nie aus dem Zahlungsstand abgeleitet: Der kann sich nach dem Belegdatum noch
 * ändern, und die Voranmeldung des Belegmonats ist dann womöglich schon abgegeben (#786).
 */
export function erstattetBezahltesProblem(
  summen: { gross: Cents },
  reverseCharge: string | null,
  payment: "bank" | "privat" | "kasse",
  category?: string | null,
): string | null {
  if (summen.gross >= 0) return "„Erstattet bereits Bezahltes“ gibt es nur an einer Gutschrift, also an einem negativen Beleg";
  if (reverseCharge) return "„Erstattet bereits Bezahltes“ gibt es nicht bei § 13b oder innergemeinschaftlichem Erwerb";
  if (category === "einfuhrumsatzsteuer") return "„Erstattet bereits Bezahltes“ gibt es nicht beim Bescheid des Zolls";
  // Ausgleichen geht nur über die Bank (Erstattung, Verrechnung, Ausbuchung); privat oder bar bezahlt käme die
  // Vorsteuerminderung nie vom Zwischenkonto herunter
  if (payment !== "bank") return "„Erstattet bereits Bezahltes“ gibt es nur an Belegen, die über die Bank bezahlt sind";
  return null;
}

/** Fehlender Kurs: noch nicht veröffentlicht (laufender oder späterer Monat) oder nicht vorhanden */
function missingRateIssue(doc: Document, todayDate: string): string {
  if (!doc.documentDate) return `Umrechnungskurs für ${doc.currency} fehlt`;
  const month = rateMonth(doc.documentDate);
  return month >= rateMonth(todayDate)
    ? `Kurs für ${formatRateMonth(month)} noch nicht veröffentlicht; Haben übernimmt ihn nach Monatsende, oder trag einen Kurs von Hand ein`
    : `Umrechnungskurs für ${doc.currency} ${formatRateMonth(month)} fehlt`;
}

/**
 * Innergemeinschaftlicher Erwerb (§ 1a UStG), unabhängig von der Kategorie, auch für Anlagegüter: Der Lieferant ist
 * Unternehmer in einem anderen Mitgliedstaat (seine USt-IdNr. steht auf der Rechnung, § 14a Abs. 3 UStG) und berechnet
 * keine deutsche Umsatzsteuer. Haben rechnet die Erwerbsteuer zu 19 oder 7 %; steuerfreie Erwerbe (§ 4b UStG, Kz 91)
 * und andere Sätze (Kz 95/98) unterstützt es nicht.
 */
function igErwerbIssues(doc: Document, amounts: DocumentAmount[]): BookingIssue[] {
  const issues: BookingIssue[] = [];
  if (amounts.some((a) => a.taxRate === 0)) issues.push({ text: "Beim innergemeinschaftlichen Erwerb steht jede Zeile auf 19 % oder 7 %" });
  // Geprüft wie die USt-IdNr. einer Lieferung in der Zusammenfassenden Meldung, dazu der Aufbau je Mitgliedstaat (#1413)
  const ustId = normalizeUstId(doc.supplierUstId ?? "");
  const feld = "supplierUstId";
  if (!ustId) issues.push({ text: "Beim innergemeinschaftlichen Erwerb fehlt die USt-IdNr. des Lieferanten", feld });
  else if (ustId.startsWith("DE"))
    issues.push({ text: "Lieferant mit deutscher USt-IdNr.: kein innergemeinschaftlicher Erwerb, die Rechnung muss deutsche Umsatzsteuer ausweisen", feld });
  else {
    const problem = ustIdProblem(ustId, "L") ?? ustIdAufbauProblem(ustId);
    if (problem) issues.push({ text: `Lieferant ${problem}`, feld });
  }
  return issues;
}

// Sperren beim innergemeinschaftlichen Erwerb, die Firma oder wirksamen Abzug kennen: Wer nur steuerfreie Umsätze
// ohne Vorsteuerabzug ausführt (auch Kleinunternehmer, § 19 Abs. 1 UStG), erwirbt nur oberhalb der Erwerbsschwelle
// oder mit Verzicht steuerpflichtig (§ 1a Abs. 3 Nr. 1 Buchst. a und Abs. 4 UStG). Die Erwerbsteuer in den
// Anschaffungskosten einer Anlage wirkt nur über AfA, die Zahlung ans Finanzamt läge in der EÜR sonst zusätzlich
// als Ausgabe — doppelt (§ 9b Abs. 1, § 4 Abs. 3 Satz 3 EStG); bis die EÜR das trennt: sperren
export function igErwerbFirmaIssues(doc: Document, category: string | null, company: Company, vollerVorsteuerabzug: boolean): string[] {
  if (doc.reverseCharge !== "ig_erwerb") return [];
  if (company.kleinunternehmer || company.ohneVorsteuerabzug)
    return [
      "Innergemeinschaftlicher Erwerb als Kleinunternehmer oder mit nur steuerfreien Umsätzen (Erwerbsschwelle, § 1a Abs. 3 UStG) wird nicht unterstützt",
    ];
  if (category === "anlage" && !vollerVorsteuerabzug)
    return ["Innergemeinschaftlicher Erwerb einer Anlage ohne Vorsteuerabzug oder mit Teilabzug wird nicht unterstützt"];
  return [];
}

/** Was vor dem Buchen fehlt, als Satz; `feld` nennt das Feld am Beleg, an dem es liegt, benannt wie in `documentInputSchema` */
export interface BookingIssue {
  text: string;
  feld?: keyof DocumentInput;
}

/** Was vor dem Buchen fehlt; leere Liste = bereit. Geprüft werden die Positionen (#1975). */
export function bookingIssues(
  doc: Document,
  amounts: DocumentAmount[],
  todayDate: string,
  positionen: readonly Belegposition[],
  rechtsform?: Rechtsform,
): string[] {
  return bookingIssueList(doc, amounts, todayDate, positionen, rechtsform).map((issue) => issue.text);
}

/**
 * Passt die Kontierung? Ohne Positionen oder mit einer ohne Kategorie fehlt sie. Eine betriebliche Kontierung neben
 * Entnahmen braucht nur Positionen, die je Satz die Beträge ergeben; mehrere prüft splitBookingIssues wie eine Aufteilung.
 */
function kontierungIssues(doc: Document, amounts: DocumentAmount[], positionen: readonly Belegposition[], rechtsform?: Rechtsform): string[] {
  if (positionen.length === 0 || positionen.some((p) => p.category === null)) return ["Kategorie fehlt"];
  if (!einzigePosition(positionen)) return splitBookingIssues(doc, amounts, positionen, rechtsform);
  const issues: string[] = [];
  // Eine Entnahme gibt es nur im Einzelunternehmen; in GmbH und UG ist privat Genutztes Arbeitslohn oder verdeckte
  // Gewinnausschüttung (privatZulaessig, wie in der Buchung)
  if (rechtsform && !privatZulaessig(rechtsform) && positionen.some(istEntnahme)) issues.push("Einen Privatanteil gibt es nur im Einzelunternehmen");
  return [...issues, ...satzIssues(splitLines(positionen), amounts)];
}

/** Wie bookingIssues, je Hinweis mit dem Feld, an dem er liegt */
export function bookingIssueList(
  doc: Document,
  amounts: DocumentAmount[],
  todayDate: string,
  positionen: readonly Belegposition[],
  rechtsform?: Rechtsform,
): BookingIssue[] {
  const issues: BookingIssue[] = [];
  const add = (...texts: string[]) => issues.push(...texts.map((text) => ({ text })));
  const category = belegKategorie(positionen);
  if (!doc.supplierName) add("Lieferant fehlt");
  if (!doc.documentDate) add("Belegdatum fehlt");
  add(...kontierungIssues(doc, amounts, positionen, rechtsform));
  const foreign = doc.currency !== "EUR";
  if (foreign && !doc.exchangeRate) issues.push({ text: missingRateIssue(doc, todayDate), feld: "exchangeRate" });
  if (foreign && amounts.some((a) => a.originalNet === null || a.originalTax === null)) add(`Beträge in ${doc.currency} fehlen`);
  // Bei Fremdwährung zählen die Beträge laut Beleg; ohne Kurs stehen die Euro-Beträge noch auf 0
  const values = foreign ? amounts.map((a) => ({ net: a.originalNet ?? 0, tax: a.originalTax ?? 0 })) : amounts;
  if (values.length === 0 || values.every((a) => a.net === 0 && a.tax === 0)) add("Beträge fehlen");
  // Mit Kurs, aber umgerechnet 0,00 € (winzige Beträge oder ein falscher Kurs): eine Buchung ohne Zeilen ginge nicht
  else if (foreign && doc.exchangeRate && amounts.every((a) => a.net === 0 && a.tax === 0))
    issues.push({ text: "Umgerechnet 0,00 €, bitte den Kurs prüfen", feld: "exchangeRate" });
  // Vor #331 ließ sich die selbst geschuldete Steuer von Hand ändern; solche Entwürfe erst neu speichern
  if (doc.reverseCharge && !foreign && amounts.some((a) => a.tax !== taxOf(a.net, a.taxRate))) {
    add(`${doc.reverseCharge === "ig_erwerb" ? "Erwerbsteuer" : "Steuer § 13b"} passt nicht zu Netto und Satz; öffne den Beleg und speichere ihn`);
  }
  if (doc.reverseCharge === "ig_erwerb") issues.push(...igErwerbIssues(doc, amounts));
  else if (doc.reverseCharge) {
    if (amounts.some((a) => a.taxRate === 0)) add("Bei § 13b steht jede Zeile auf 19 % oder 7 %");
    if (category === "anlage") add("§ 13b bei Anlagegütern wird nicht unterstützt");
    // § 13b Abs. 1 und Abs. 2 Nr. 1 UStG: nur sonstige Leistungen und Werklieferungen; Waren sind innergemeinschaftlicher Erwerb (§ 1a UStG) oder Einfuhr
    if (category === "wareneinkauf") add("§ 13b gilt nicht für Wareneinkäufe");
  }
  if (category === "anlage") {
    const net = amounts.reduce((s, a) => s + a.net, 0);
    if (!doc.asset) add("Angaben zur Anlage fehlen");
    else if (doc.privateShare > 0 || positionen.some(istEntnahme)) add("Ein Privatanteil bei Anlagegütern wird nicht unterstützt");
    else if (net <= 0) add("Gutschriften zu Anlagen werden nicht unterstützt");
    else if (doc.documentDate) {
      add(...assetIssues(documentScheduleAsset(doc.asset, doc.documentDate, net)));
    }
  }
  return issues;
}

/**
 * Anlage aus dem Beleg: Nutzungsdauer nur bei linear und degressiv, bei degressiv der Höchstsatz (§ 7 Abs. 2 EStG).
 * Satz, Wechsel zur linearen AfA und Erinnerungswert lassen sich an der Anlage bis zur ersten AfA noch ändern.
 */
export function documentAssetMethod(asset: { method: AssetMethod; usefulLifeMonths: number | null }, acquisitionDate: string) {
  const usefulLifeMonths = usesUsefulLife(asset.method) ? asset.usefulLifeMonths : null;
  const degressiveRate = asset.method === "degressiv" && usefulLifeMonths ? maxDegressiveRate(acquisitionDate, usefulLifeMonths) : null;
  return { usefulLifeMonths, degressiveRate };
}

function documentScheduleAsset(asset: { kind: AssetKind; method: AssetMethod; usefulLifeMonths: number | null }, acquisitionDate: string, cost: Cents) {
  return { acquisitionDate, cost, kind: asset.kind, method: asset.method, ...documentAssetMethod(asset, acquisitionDate) };
}

/**
 * Lehnt das Buchen ab, solange etwas fehlt: die Hinweise aus bookingIssueList und was erst die Firma und der gespeicherte
 * Stand zeigen (Rechtsform, Erwerb, Einfuhrumsatzsteuer, gemeldeter Zeitraum, eigene Konten).
 */
export async function pruefeBuchungsreife(
  tx: Tx,
  doc: Document,
  amounts: DocumentAmount[],
  positionen: readonly Belegposition[],
  company: Company,
  wirksameBetraege: readonly { vorsteuerAnteil: number }[],
): Promise<void> {
  const vorab = bookingIssueList(doc, amounts, today(), positionen, company.rechtsform);
  const issues = vorab.map((issue) => issue.text);
  const eine = einzigePosition(positionen);
  const category = belegKategorie(positionen);
  const vollerAbzug = wirksameBetraege.every((a) => a.vorsteuerAnteil === VOLLER_ABZUG);
  if (category === "anlage" && doc.asset?.method === "elektro" && !elektroAvailable(company.rechtsform)) issues.push(ELEKTRO_NUR_EINZELUNTERNEHMEN);
  issues.push(...igErwerbFirmaIssues(doc, category, company, vollerAbzug));
  // Einfuhrumsatzsteuer (Kz 62): nur der Bescheid des Zolls allein, als Vorsteuer
  if (eine?.category === "einfuhrumsatzsteuer") {
    const rows = amounts.map((a) => ({ rate: a.taxRate, base: a.net, tax: a.tax }));
    issues.push(...einfuhrumsatzsteuerIssues({ taxes: rows }, vollerAbzug, privatteil(doc, positionen), doc.reverseCharge));
  }
  if (!eine && positionen.some((p) => p.category === "einfuhrumsatzsteuer"))
    issues.push("Die Einfuhrumsatzsteuer lässt sich nicht mit anderen Kategorien aufteilen");
  // Gutschrift, die bereits Bezahltes erstattet (#786): nur an einer Gutschrift und nur im noch nicht gemeldeten Zeitraum
  if (doc.erstattetBezahltes) {
    const problem = erstattetBezahltesProblem(totalsOf(amounts, doc.reverseCharge), doc.reverseCharge, doc.payment, category);
    if (problem) issues.push(problem);
    else if (doc.documentDate && (await periodReported(tx, doc.documentDate))) {
      issues.push("Der Belegmonat ist schon gemeldet; die Vorsteuerminderung nach § 17 Abs. 1 Satz 2 UStG lässt sich nicht mehr in ihm ziehen");
    }
  }
  // Eigene Sachkonten (#270): Kontenrahmen oder Kategorie können sich seit dem Speichern geändert haben; das Konto selbst
  // darf archiviert sein. Die Konten stehen in den Positionen
  const gespeichert = { beleg: null, zeilen: positionen.map((p) => p.ownAccountId) };
  const konten = await documentOwnAccountProblems(tx, { ownAccountId: null, category: null }, positionen, gespeichert);
  issues.push(...konten.map((p) => p.replace(/.$/, "")));
  // Mit den Feldern der Hinweise, damit die Seite sie zeigen kann
  const felder = vorab.flatMap((issue) => (issue.feld ? [issue.feld] : []));
  if (issues.length > 0) throw new DocumentError(`Noch nicht bereit: ${issues.join(", ")}.`, { felder });
}
