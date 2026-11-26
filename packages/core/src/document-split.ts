import type { InvoiceTotals } from "./invoice.ts";
import { documentRateExpenses } from "./document-posting.ts";
import { formatEuro, roundHalfAwayFromZero, splitPrivateShare, type BasisPoints, type Cents, type Prozent } from "./money.ts";
import {
  ACCOUNTS,
  EXPENSE_CATEGORIES,
  inputTaxCode,
  ownerAccount,
  REVERSE_CHARGE_IN,
  side,
  type ReverseChargeIn,
  type DocumentPayment,
  type ExpenseCategory,
  type Kontenrahmen,
  type PostingLine,
  type TaxCode,
  vatRate,
} from "./posting.ts";
import { isKapitalgesellschaft, type Rechtsform } from "./rechtsform.ts";
import { abziehbareSteuer, buchungsAnteil, VOLLER_ABZUG } from "./vorsteuerabzug.ts";

/*
 * Aufteilung eines Eingangsbelegs auf mehrere Kontierungszeilen (#271): Ein Beleg, eine Zahlung, ein offener Posten, aber
 * das Netto geht auf verschiedene Kategorien, z. B. Handelsware, Software und Bürobedarf auf derselben Rechnung.
 *
 * Maßgeblich bleiben die Beträge des Belegs je Steuersatz (document_amounts): Die Vorsteuer steht auf der Rechnung und
 * wird wie bisher nicht nachgerechnet. Die Zeilen tragen Kategorie, Steuersatz und Netto; ihr Netto muss je Satz genau
 * das Netto des Belegs ergeben. Die Vorsteuer eines Satzes verteilt Haben anteilig nach Netto auf seine Zeilen und rundet
 * kaufmännisch; den Rundungsrest trägt die betragsmäßig größte Zeile des Satzes, wie beim Netto einer Bruttorechnung
 * (computeInvoice) und beim Steueranteil einer Teilzahlung (paidTaxShares). So ergeben die Zeilen je Satz exakt Netto
 * und Vorsteuer des Belegs.
 */

/** Eine Kontierungszeile, wie sie eingegeben wird */
export interface DocumentSplitLine {
  category: ExpenseCategory;
  /** Eigenes Sachkonto (#270) der Kategorie: gebucht wird auf dessen Nummer statt auf das Konto der Kategorie */
  account?: string;
  taxRate: BasisPoints;
  net: Cents;
  /** Privatanteil dieser Zeile in Prozent (#1914); fehlt er, gilt die Zeile als betrieblich */
  privateShare?: Prozent;
}

/** Kontierungszeile mit ihrem Anteil an der Vorsteuer des Satzes */
export interface AllocatedSplitLine extends DocumentSplitLine {
  tax: Cents;
}

/** Beträge des Belegs je Steuersatz */
export interface DocumentRateAmount {
  taxRate: BasisPoints;
  net: Cents;
  tax: Cents;
  vorsteuerAnteil?: BasisPoints | null;
}

const sum = (values: Cents[]) => values.reduce((s, v) => s + v, 0);

/**
 * Verteilt die Vorsteuer je Satz anteilig nach Netto auf die Zeilen dieses Satzes; die Summe je Satz ist exakt die Steuer
 * des Belegs. Stimmt das Netto der Zeilen (noch) nicht, wird nach ihrem eigenen Netto verteilt; ohne Netto bleibt die
 * Steuer bei 0, das meldet splitIssues.
 */
export function allocateSplitTax(lines: DocumentSplitLine[], amounts: DocumentRateAmount[]): AllocatedSplitLine[] {
  const result: AllocatedSplitLine[] = lines.map((line) => ({ ...line, tax: 0 }));
  for (const amount of amounts) {
    const indexes = lines.flatMap((line, i) => (line.taxRate === amount.taxRate ? [i] : []));
    const base = sum(indexes.map((i) => lines[i]!.net));
    if (indexes.length === 0 || base === 0) continue;
    for (const i of indexes) result[i]!.tax = roundHalfAwayFromZero((amount.tax * lines[i]!.net) / base);
    const rest = amount.tax - sum(indexes.map((i) => result[i]!.tax));
    const largest = indexes.reduce((best, i) => (Math.abs(lines[i]!.net) > Math.abs(lines[best]!.net) ? i : best), indexes[0]!);
    result[largest]!.tax += rest;
  }
  return result;
}

const percent = (rate: BasisPoints) => `${rate / 100} %`;

/**
 * Was gegen die Aufteilung spricht; leere Liste = sie passt zum Beleg. Geprüft wird je Steuersatz: Netto der Zeilen
 * gleich Netto des Belegs, die verteilte Vorsteuer gleich der Vorsteuer des Belegs, und jede Zeile mit demselben
 * Vorzeichen wie der Beleg (eine Gutschrift hat nur negative Zeilen).
 */
export function splitIssues(lines: AllocatedSplitLine[], amounts: DocumentRateAmount[]): string[] {
  const issues: string[] = [];
  if (lines.length < 2) issues.push("Eine Aufteilung braucht mindestens zwei Zeilen; für eine Kategorie wähle sie direkt");
  if (lines.some((line) => line.category === "anlage")) issues.push("Anlagegüter lassen sich nicht aufteilen; erfasse sie als eigenen Beleg");
  if (lines.some((line) => line.net === 0)) issues.push("Jede Zeile der Aufteilung braucht einen Nettobetrag");
  const rates = [...new Set([...amounts.map((a) => a.taxRate), ...lines.map((l) => l.taxRate)])].sort((a, b) => b - a);
  for (const rate of rates) {
    const amount = amounts.find((a) => a.taxRate === rate) ?? { taxRate: rate, net: 0, tax: 0 };
    const own = lines.filter((line) => line.taxRate === rate);
    const net = sum(own.map((line) => line.net));
    if (net !== amount.net) {
      issues.push(`Aufteilung ${percent(rate)}: Zeilen zusammen ${formatEuro(net)} netto, Beleg ${formatEuro(amount.net)}`);
      continue;
    }
    const tax = sum(own.map((line) => line.tax));
    if (tax !== amount.tax) issues.push(`Aufteilung ${percent(rate)}: Vorsteuer der Zeilen ${formatEuro(tax)}, Beleg ${formatEuro(amount.tax)}`);
    // Nicht am Vorzeichen des Belegs gemessen: In einem Satz, den der Beleg nicht hat (Netto 0), höben sich +x und −x sonst auf
    if (own.some((line) => line.net > 0) && own.some((line) => line.net < 0)) {
      issues.push(`Aufteilung ${percent(rate)}: Zeilen mit Plus und Minus gemischt; eine Gutschrift hat nur negative Zeilen`);
    }
  }
  return issues;
}

/**
 * Abziehbarer Anteil je Zeile. Ohne Privatanteil wird der Abzug des Satzes gerundet und nach Netto auf seine Zeilen
 * verteilt (`allocateSplitTax`), den Rundungsrest trägt die größte. Mit Privatanteil zählt die betriebliche Steuer der
 * Zeilen: Bei vollem Abzug bleibt sie je Zeile stehen (wie in euer-beleg.ts), sonst wird der abziehbare Teil des Satzes
 * nach betrieblichem Netto verteilt. So entsteht bei 100 % keine Phantomzeile keineVSt, und Buchung und EÜR bleiben gleich.
 */
function splitDeductibles(lines: AllocatedSplitLine[], totals: InvoiceTotals, vorsteuerAbzug: boolean | BasisPoints, mitPrivat: boolean): Cents[] {
  if (!mitPrivat)
    return allocateSplitTax(
      lines,
      totals.taxes.map((t) => ({ taxRate: t.rate, net: t.base, tax: abziehbareSteuer(t.tax, buchungsAnteil(vorsteuerAbzug, t.vorsteuerAnteil)) })),
    ).map((line) => line.tax);
  const betrieblich = lines.map((line) => ({
    net: splitPrivateShare(line.net, line.privateShare ?? 0).business,
    tax: splitPrivateShare(line.tax, line.privateShare ?? 0).business,
  }));
  const result = lines.map(() => 0);
  for (const t of totals.taxes) {
    const indexes = lines.flatMap((line, i) => (line.taxRate === t.rate ? [i] : []));
    if (indexes.length === 0) continue;
    const anteil = buchungsAnteil(vorsteuerAbzug, t.vorsteuerAnteil);
    // Voller Abzug: jede Zeile behält ihre betriebliche Steuer; die Summe ist die des Satzes, ohne Verteilung
    if (anteil === VOLLER_ABZUG) {
      for (const i of indexes) result[i] = betrieblich[i]!.tax;
      continue;
    }
    const steuer = abziehbareSteuer(
      indexes.reduce((s, i) => s + betrieblich[i]!.tax, 0),
      anteil,
    );
    const verteilt = allocateSplitTax(
      indexes.map((i) => ({ category: lines[i]!.category, taxRate: lines[i]!.taxRate, net: betrieblich[i]!.net })),
      [{ taxRate: t.rate, net: 0, tax: steuer }],
    );
    for (const [k, i] of indexes.entries()) result[i] = verteilt[k]!.tax;
  }
  return result;
}

/** Steuerzeilen des Belegs: je Satz eine Vorsteuerzeile, bei § 13b eine Umsatzsteuerzeile und die Vorsteuer dazu (#1914) */
function splitTaxPosting(
  totals: InvoiceTotals,
  abziehbar: ReadonlyMap<number, Cents>,
  options: { kontenrahmen: Kontenrahmen; rcCode: TaxCode | null; parken: boolean; vorsteuerAbzug: boolean | BasisPoints; mitPrivat: boolean },
): PostingLine[] {
  const accounts = ACCOUNTS[options.kontenrahmen];
  const result: PostingLine[] = [];
  for (const row of totals.taxes) {
    const { rate, tax } = row;
    if (tax === 0) continue;
    const abzugsfaehig = abziehbar.get(rate) ?? (options.mitPrivat ? 0 : abziehbareSteuer(tax, buchungsAnteil(options.vorsteuerAbzug, row.vorsteuerAnteil)));
    const satz = vatRate(rate);
    if (options.rcCode) {
      if (abzugsfaehig !== 0) result.push(side(accounts.vorsteuerRc, abzugsfaehig, true, "VSt13b"));
      result.push(side(accounts.ustRc, tax, false, options.rcCode));
    } else if (abzugsfaehig !== 0) {
      const konto = options.parken ? accounts.vorsteuerNochNichtAbziehbar : accounts.vorsteuer[satz];
      result.push(side(konto, abzugsfaehig, true, inputTaxCode(satz)));
    }
  }
  return result;
}

/**
 * Buchung eines aufgeteilten Belegs: eine Buchung mit einer Aufwandszeile je Kategorie und Steuersatz (gleiche Kategorie
 * und gleicher Satz zusammengefasst), Vorsteuer je Satz in Höhe des Belegs, an Verbindlichkeiten, Privateinlage bzw.
 * Gesellschafter oder Kasse über den ganzen Betrag. Ohne Vorsteuerabzug (Kleinunternehmer) gehört der Steueranteil jeder
 * Zeile zu ihrem Aufwand. Gutschriften (negativ) drehen die Seiten. Innergemeinschaftlicher Erwerb und Anlagegüter gibt es
 * mit Aufteilung nicht (siehe splitBookingIssues); totals sind die Beträge des Belegs je Satz.
 *
 * Privatanteil je Zeile (#1914): Jede Zeile trägt ihren eigenen Anteil (Internet 25 %, Telefon 40 % auf einem Beleg). Nur
 * ihr betrieblicher Teil ist Aufwand und Vorsteuer; der private Teil aller Zeilen steht als eine Entnahme auf
 * privatentnahmen. Trägt keine Zeile einen Anteil, bucht Haben wie bisher.
 *
 * § 13b (#508) wie in documentPosting: Der Aufwand jeder Zeile trägt RC13bEU bzw. RC13bDrittland, die selbst geschuldete
 * Steuer steht je Satz einmal als Umsatzsteuer und, mit Vorsteuerabzug, im selben Betrag als Vorsteuer (VSt13b); gezahlt
 * wird nur netto (totals.gross = Netto). Ohne Vorsteuerabzug ist die Steuer Aufwand: je Zeile ihr Anteil aus
 * allocateSplitTax, so ergibt die Summe centgenau die Steuer des Belegs; er steht als eigene Zeile mit keineVSt neben dem
 * Netto, damit die Bemessungsgrundlage (Kz 46/84) im Journal stimmt.
 */
export function documentSplitPosting(
  totals: InvoiceTotals,
  lines: AllocatedSplitLine[],
  kontenrahmen: Kontenrahmen,
  rechtsform: Rechtsform,
  payment: DocumentPayment,
  vorsteuerAbzug: boolean | BasisPoints = true,
  reverseCharge: ReverseChargeIn | null = null,
  /** Gutschrift erstattet bereits Bezahltes (#786): Vorsteuerminderung erst mit dem Ausgleich, bis dahin Zwischenkonto */
  erstattetBezahltes = false,
  /** Leistung beim Buchen noch nicht ausgeführt (#693): Vorsteuer auf das Zwischenkonto bis zur Freigabe oder Zahlung */
  vorsteuerNochNichtAbziehbar = false,
): PostingLine[] {
  const accounts = ACCOUNTS[kontenrahmen];
  if (erstattetBezahltes) {
    if (totals.gross >= 0) throw new RangeError("„Erstattet bereits Bezahltes“ gibt es nur an einer Gutschrift, also an einem negativen Beleg");
    if (reverseCharge) throw new RangeError("„Erstattet bereits Bezahltes“ gibt es nicht bei § 13b oder innergemeinschaftlichem Erwerb");
  }
  if (vorsteuerNochNichtAbziehbar && reverseCharge)
    throw new RangeError("Noch nicht abziehbare Vorsteuer gibt es nicht bei § 13b; er hat seinen eigenen Zeitpunkt");
  const parken = erstattetBezahltes || vorsteuerNochNichtAbziehbar;
  if (reverseCharge && !(reverseCharge in REVERSE_CHARGE_IN)) throw new RangeError(`${reverseCharge} mit Aufteilung wird nicht unterstützt`);
  const rcCode = reverseCharge ? REVERSE_CHARGE_IN[reverseCharge].code : null;
  if (rcCode && totals.taxes.some((t) => t.rate !== 1900 && t.rate !== 700)) throw new RangeError("§ 13b: Steuersatz muss 19 % oder 7 % sein");
  // Privat genutzt ist bei einer GmbH keine Entnahme, sondern Arbeitslohn oder verdeckte Gewinnausschüttung
  if (lines.some((line) => (line.privateShare ?? 0) !== 0) && isKapitalgesellschaft(rechtsform))
    throw new RangeError("Privatanteil gibt es nur im Einzelunternehmen");
  const mitPrivat = lines.some((line) => (line.privateShare ?? 0) !== 0);
  const expenses = new Map<string, { account: string; amount: Cents; code: TaxCode | null }>();
  // Der nicht abziehbare Anteil (§ 15 Abs. 4 UStG) bleibt eine eigene Zeile: Zusammen mit einer Position zu 0 % oder einem
  // Satz ohne Abzug auf demselben Konto (beide auch keineVSt) erkennte die Verprobung den Teilabzug sonst nicht (#1230)
  const add = (account: string, code: TaxCode | null, amount: Cents, nichtAbziehbar = false) => {
    const key = `${account}|${code ?? ""}|${nichtAbziehbar}`;
    const seen = expenses.get(key);
    if (seen) seen.amount += amount;
    else expenses.set(key, { account, amount, code });
  };
  // Die Summe je Satz bleibt exakt die abziehbare Steuer; mit Privatanteil nach betrieblichem Netto (#1914)
  const abzuege = splitDeductibles(lines, totals, vorsteuerAbzug, mitPrivat);
  // Vorsteuer je Satz: die Summe der abziehbaren Anteile seiner Zeilen, damit die Buchung im Soll und Haben aufgeht
  const abziehbar = new Map<number, Cents>();
  const merke = (rate: BasisPoints, amount: Cents) => abziehbar.set(rate, (abziehbar.get(rate) ?? 0) + amount);
  let privatePart = 0;
  for (const [i, line] of lines.entries()) {
    const account = line.account ?? EXPENSE_CATEGORIES[line.category][kontenrahmen];
    const betrag = totals.taxes.find((t) => t.rate === line.taxRate);
    const anteil = buchungsAnteil(vorsteuerAbzug, betrag?.vorsteuerAnteil);
    const tax = abzuege[i] ?? 0;
    if (!mitPrivat) {
      if (anteil > 0) {
        add(account, rcCode ?? inputTaxCode(line.taxRate), line.net);
        add(account, "keineVSt", line.tax - tax, true);
        merke(line.taxRate, tax);
      } else if (rcCode) {
        // § 13b ohne Vorsteuerabzug: Netto mit dem Steuerschlüssel, die Steuer als Aufwand daneben, damit das Journal die
        // Bemessungsgrundlage trägt (#542)
        add(account, rcCode, line.net);
        add(account, "keineVSt", line.tax);
      } else add(account, "keineVSt", line.net + line.tax);
      continue;
    }
    // Privatanteil der Zeile: Aufwand, Vorsteuer und Entnahme aus ihrem betrieblichen bzw. privaten Teil
    const abzug = abzuege[i]!;
    const eigen = documentRateExpenses(
      { rate: line.taxRate, base: line.net, tax: line.tax, vorsteuerAnteil: betrag?.vorsteuerAnteil ?? null },
      {
        expense: account,
        kontenrahmen,
        vorsteuerAbzug: anteil,
        privateShare: line.privateShare ?? 0,
        reverseCharge: rcCode ? reverseCharge : null,
        deductible: abzug,
      },
    );
    for (const entry of eigen.lines) add(entry.account, entry.code, entry.amount, entry.nichtAbziehbar);
    privatePart += eigen.privatePart;
    merke(line.taxRate, abzug);
  }
  // Der private Teil aller Zeilen ist eine Entnahme; privat bezahlt heben sich Einlage und Entnahme insoweit auf
  if (privatePart !== 0) add(accounts.privatentnahmen, null, privatePart);
  const result: PostingLine[] = [...expenses.values()].map((e) => side(e.account, e.amount, true, e.code));
  // Je Satz genau eine Steuerzeile, auch bei § 13b und mehreren Zeilen desselben Satzes (#1914)
  result.push(...splitTaxPosting(totals, abziehbar, { kontenrahmen, rcCode, parken, vorsteuerAbzug, mitPrivat }));
  const counter = payment === "privat" ? ownerAccount(kontenrahmen, rechtsform, "einlage") : payment === "kasse" ? accounts.kasse : accounts.verbindlichkeiten;
  result.push(side(counter, totals.gross, false, null));
  return result.filter((line) => line.debit !== 0 || line.credit !== 0);
}
