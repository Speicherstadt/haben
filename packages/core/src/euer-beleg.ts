import type { EuerPayment } from "./euer.ts";
import { allocateSplitTax } from "./document-split.ts";
import { betrieblicherAnteil, privaterAnteil } from "./beleg-anteile.ts";
import { PRIVATENTNAHME } from "./kontenplan.ts";
import { roundHalfAwayFromZero, type BasisPoints, type Cents } from "./money.ts";
import { paidTaxShares, type ExpenseCategory, type TaxShare } from "./posting.ts";
import { abziehbareSteuer, gespeicherterAnteil } from "./vorsteuerabzug.ts";

type DocumentPayment = Extract<EuerPayment, { kind: "document" }>;
/**
 * `journal`: der Aufwand der Zeile, aufgeteilt wie documentSplitPosting ihn bucht (Schlüssel aus Konto, Steuerschlüssel
 * und „nicht abziehbar“); nur mit Entnahmezeile (#1975), damit die 70-%-Grenze der Bewirtung je Journalzeile gilt.
 */
type Share = { category: ExpenseCategory; share: TaxShare; deductible: Cents; journal?: { key: string; amount: Cents }[] };

/** Gezahlte Steuer je Satz; der Rundungsrest geht nur an Sätze mit Steuer, nie an einen steuerfreien */
function gezahlteSteuerJeSatz(totals: DocumentPayment["totals"], paid: Cents): TaxShare[] {
  const rows = paidTaxShares(totals, paid);
  const besteuert = (rate: BasisPoints) => (totals.taxes.find((t) => t.rate === rate)?.tax ?? 0) !== 0;
  const ziel = rows.reduce<number>((best, row, i) => (besteuert(row.rate) && (best < 0 || Math.abs(row.base) > Math.abs(rows[best]!.base)) ? i : best), -1);
  if (ziel < 0) return rows;
  return rows.map((row, i) =>
    i === ziel
      ? { ...row, tax: row.tax + rows.filter((r) => !besteuert(r.rate)).reduce((sum, r) => sum + r.tax, 0) }
      : besteuert(row.rate)
        ? row
        : { ...row, tax: 0 },
  );
}

export interface DocumentEuerEffect {
  expenses: { category: ExpenseCategory; amount: Cents }[];
  vorsteuer: Cents;
  bewirtungNichtAbziehbar: Cents;
  privateUst: Cents;
}

export interface DocumentEuerEvent {
  id: string;
  paid: Cents;
  reversesId: string | null;
}

/** Addiert bereits gerundete Wirkungen; Gegenzeilen nehmen exakt die Wirkung ihres Ursprungs zurück. */
export function addDocumentEffects(a: DocumentEuerEffect, b: DocumentEuerEffect, sign = 1): DocumentEuerEffect {
  const expenses = new Map<ExpenseCategory, Cents>();
  for (const e of a.expenses) expenses.set(e.category, (expenses.get(e.category) ?? 0) + e.amount);
  for (const e of b.expenses) expenses.set(e.category, (expenses.get(e.category) ?? 0) + sign * e.amount);
  return {
    expenses: [...expenses].map(([category, amount]) => ({ category, amount })),
    vorsteuer: a.vorsteuer + sign * b.vorsteuer,
    bewirtungNichtAbziehbar: a.bewirtungNichtAbziehbar + sign * b.bewirtungNichtAbziehbar,
    privateUst: a.privateUst + sign * b.privateUst,
  };
}

/**
 * Die Originalsteuer bleibt Grundlage der Zahlungsaufteilung; nur der nach § 15 Abs. 4 UStG zugeordnete Anteil ist
 * gezahlte Vorsteuer. Der Rest gehört zum Aufwand (§ 9b Abs. 1 EStG). Privatanteil und Abzugsanteil sind getrennt.
 * https://www.gesetze-im-internet.de/ustg_1980/__15.html; https://www.gesetze-im-internet.de/estg/__9b.html
 */
function documentShares(p: DocumentPayment, paid: Cents): Share[] {
  const anteil = (rate: BasisPoints) => gespeicherterAnteil(p, p.totals.taxes.find((t) => t.rate === rate)?.vorsteuerAnteil);
  if (!p.splits?.length) {
    return paidTaxShares(p.totals, paid).map((share) => ({
      category: p.category,
      share,
      deductible: abziehbareSteuer(betrieblicherAnteil(share.tax, p.privateShare ?? 0), anteil(share.rate)),
    }));
  }
  const lines = p.splits;
  // § 13b und Erwerb: gezahlt ist nur netto, auch je Zeile. Die Steuer der Zeilen bleibt trotzdem in p.splits, weil die
  // Steuer der Entnahmezeilen als Umsatzsteuer auf die Entnahme zählt (documentTarget, #1975)
  const selbstGeschuldet = (p.selbstGeschuldet?.length ?? 0) > 0;
  const zeilenAnteile = paidTaxShares({ ...p.totals, taxes: lines.map((l) => ({ rate: l.taxRate, base: l.net, tax: selbstGeschuldet ? 0 : l.tax })) }, paid);
  // Mit Entnahmezeile (#1975) teilt sich die gezahlte Steuer je Satz wie beim Buchen: die Entnahme kaufmännisch gerundet,
  // der Betrieb den Rest (allocateSplitTax), wie beim Privatanteil am Beleg. Der Rundungsrest des ganzen Belegs fiele
  // sonst auf die größte Zeile, und der Betrieb bekäme einen Cent Vorsteuer, der zur Entnahme gehört.
  const mitEntnahme = lines.some((line) => line.category === PRIVATENTNAHME);
  const steuerJeZeile = mitEntnahme
    ? allocateSplitTax(
        lines,
        gezahlteSteuerJeSatz(p.totals, paid).map((r) => ({ taxRate: r.rate, net: r.base, tax: selbstGeschuldet ? 0 : r.tax })),
      )
    : null;
  const shares = steuerJeZeile ? zeilenAnteile.map((share, i) => ({ ...share, tax: steuerJeZeile[i]!.tax })) : zeilenAnteile;
  // Der Abzug wird je Satz gerundet und auf die Kontierungszeilen verteilt, wie die Originalsteuer: Zwei kleine Zeilen
  // dürfen zusammen keinen zusätzlichen Cent Vorsteuer bekommen. Die größte Zeile trägt den Rundungsrest. Abziehbar ist
  // nur die Steuer der betrieblichen Zeilen; die Entnahme (#1975) trägt keine Vorsteuer, wie in documentSplitPosting.
  const betrieb = lines.flatMap((line, i) => (line.category === PRIVATENTNAHME ? [] : [i]));
  const amounts = p.totals.taxes.map((t) => ({
    taxRate: t.rate,
    net: betrieb.filter((i) => lines[i]!.taxRate === t.rate).reduce((sum, i) => sum + lines[i]!.net, 0),
    tax: abziehbareSteuer(
      betrieb.filter((i) => shares[i]!.rate === t.rate).reduce((sum, i) => sum + shares[i]!.tax, 0),
      anteil(t.rate),
    ),
  }));
  const betriebAbzug = allocateSplitTax(
    betrieb.map((i) => lines[i]!),
    amounts,
  );
  const deductible = new Map(betrieb.map((i, k) => [i, betriebAbzug[k]!.tax]));
  return shares.map((share, i) => {
    const abzug = anteil(share.rate) === 10_000 ? share.tax : (deductible.get(i) ?? 0);
    if (!mitEntnahme) return { category: lines[i]!.category, share, deductible: abzug };
    // Wie documentSplitPosting: mit Abzug Netto mit Steuerschlüssel und der nicht abziehbare Teil eigens, ohne Abzug
    // bei § 13b Netto und Steuer getrennt, sonst brutto mit keineVSt
    const konto = lines[i]!.account ?? lines[i]!.category;
    const code = selbstGeschuldet ? "rc" : `vst${share.rate}`;
    const journal =
      anteil(share.rate) > 0
        ? [
            { key: `${konto}|${code}|false`, amount: share.base },
            { key: `${konto}|keineVSt|true`, amount: share.tax - abzug },
          ]
        : selbstGeschuldet
          ? [
              { key: `${konto}|rc|false`, amount: share.base },
              { key: `${konto}|keineVSt|false`, amount: share.tax },
            ]
          : [{ key: `${konto}|keineVSt|false`, amount: share.base + share.tax }];
    return { category: lines[i]!.category, share, deductible: abzug, journal };
  });
}

/** Wirkung eines kumulierten Zahlbetrags, ohne AfA und Zahlungen ans Finanzamt */
function documentTarget(p: DocumentPayment, paid: Cents): DocumentEuerEffect {
  const expenses: { category: ExpenseCategory; amount: Cents }[] = [];
  let vorsteuer = 0;
  let bewirtungNichtAbziehbar = 0;
  // Bewirtung je Journalzeile: Fasst das Journal Zeilen gleichen Kontos und Schlüssels zusammen, gilt die 70-%-Grenze
  // für die Summe, nicht je Zeile der Aufteilung (§ 4 Abs. 5 Satz 1 Nr. 2 EStG)
  const bewirtung = new Map<string, Cents>();
  for (const { category, share, deductible, journal } of documentShares(p, paid)) {
    // Die Privatentnahme ist keine Betriebsausgabe (#1975): brutto auf dem Entnahmekonto, ohne Vorsteuer und ohne
    // EÜR-Zeile. Sie steckt im Zahlbetrag, aber nicht im Aufwand.
    if (category === PRIVATENTNAHME) continue;
    const base = betrieblicherAnteil(share.base, p.privateShare ?? 0);
    const tax = betrieblicherAnteil(share.tax, p.privateShare ?? 0);
    // Die reine Bescheidkategorie verlangt vollen Abzug; nicht abziehbare Einfuhrumsatzsteuer gehört zur Ware/Anlage.
    if (category === "einfuhrumsatzsteuer") {
      vorsteuer += share.base + share.tax;
      continue;
    }
    vorsteuer += deductible;
    // Der nicht abziehbare Teil einer Anlage gehört in die Anschaffungskosten und wirkt über die AfA.
    if (category === "anlage") continue;
    const ausgabe = base + tax - deductible;
    if (category === "bewirtung" && journal) {
      for (const { key, amount } of journal) bewirtung.set(key, (bewirtung.get(key) ?? 0) + amount);
      continue;
    }
    // § 4 Abs. 5 Satz 1 Nr. 2 EStG: Bei Bewirtung sind 70 % des Aufwands abziehbar.
    const nichtAbziehbar = category === "bewirtung" ? ausgabe - roundHalfAwayFromZero((ausgabe * 7) / 10) : 0;
    bewirtungNichtAbziehbar += nichtAbziehbar;
    expenses.push({ category, amount: ausgabe - nichtAbziehbar });
  }
  for (const ausgabe of bewirtung.values()) {
    const nichtAbziehbar = ausgabe - roundHalfAwayFromZero((ausgabe * 7) / 10);
    bewirtungNichtAbziehbar += nichtAbziehbar;
    expenses.push({ category: "bewirtung", amount: ausgabe - nichtAbziehbar });
  }
  // Selbst geschuldete Steuer steckt nicht im Zahlbetrag an den Lieferanten; sie wirkt mit der Finanzamtszahlung.
  // Nur der private Teil zählt wie bisher als Umsatzsteuer auf die Entnahme (Anlage EÜR, Zeile 17).
  // Mit Aufteilung ist es die Steuer der Entnahmezeilen (#1975)
  const entnahmeSteuer = p.selbstGeschuldet?.length
    ? (p.splits ?? []).filter((line) => line.category === PRIVATENTNAHME).reduce((sum, line) => sum + line.tax, 0)
    : 0;
  const privat = (p.selbstGeschuldet ?? []).reduce((sum, steuer) => sum + privaterAnteil(steuer, p.privateShare ?? 0), 0) + entnahmeSteuer;
  const privateUst = p.totals.gross === 0 ? 0 : roundHalfAwayFromZero((privat * paid) / p.totals.gross);
  return { expenses, vorsteuer, bewirtungNichtAbziehbar, privateUst };
}

/** Teilabzüge mit Zahlstand werden kumuliert gerundet; alte 100-/0-%-Wege rechnen weiter je Zahlung. */
export function documentEuer(p: DocumentPayment, paid: Cents): DocumentEuerEffect {
  if (p.effect) return p.effect;
  if (p.paidBefore === undefined) return documentTarget(p, paid);
  return addDocumentEffects(documentTarget(p, p.paidBefore + paid), documentTarget(p, p.paidBefore), -1);
}

/**
 * Wirkungen aus der vorhandenen Zahlungshistorie, ohne neue Speicherung. Jede reguläre Zahlung ergänzt das kumulierte
 * Ziel um den noch fehlenden Rest. Eine Rücknahme dreht die ursprüngliche Wirkung exakt um; die nächste Zahlung
 * berücksichtigt auch deren Rundungsrest, wie settlementTaxShares bei der Umsatzsteuer.
 */
export function documentEuerEffects(p: DocumentPayment, events: readonly DocumentEuerEvent[]): Map<string, DocumentEuerEffect> {
  const result = new Map<string, DocumentEuerEffect>();
  let paid = 0;
  let recorded = documentTarget(p, 0);
  for (const event of events) {
    paid += event.paid;
    const original = event.reversesId ? result.get(event.reversesId) : undefined;
    const effect = original ? addDocumentEffects(documentTarget(p, 0), original, -1) : addDocumentEffects(documentTarget(p, paid), recorded, -1);
    result.set(event.id, effect);
    recorded = addDocumentEffects(recorded, effect);
  }
  return result;
}
