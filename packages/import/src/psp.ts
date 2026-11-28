import { finish, indexed, requireAmount, type Tx } from "./common.ts";
import { isBlankRow } from "./csv.ts";
import { StatementParseError } from "./errors.ts";
import { Columns } from "./table.ts";
import { normalizeText, parseDate, parseDotAmount, parseGermanAmount } from "./text.ts";
import type { ParsedStatement } from "./types.ts";

/*
 * Exporte von Zahlungsdienstleistern (PayPal, Stripe, Shopify Payments). Anders als ein Kontoauszug enthält eine Zeile
 * Bruttobetrag, einbehaltene Gebühr und Netto. Haben legt daraus zwei Umsätze an: den Bruttobetrag (Kundenzahlung,
 * Erstattung, Auszahlung) und die Gebühr. So lässt sich der Bruttobetrag der Rechnung zuordnen (voller Erlös) und die
 * Gebühr einzeln buchen oder der Sammelrechnung des Dienstleisters zuordnen. Auszahlungen auf die Bank sind negative
 * Umsätze und werden im Bankabgleich als Geldtransit mit dem Eingang auf dem Bankkonto verbunden.
 */

/** Datum aus „30.09.2026“, „2026-09-30 12:00:00“ oder „30/09/2026“ (PayPal mit englischen Spalten aus Europa) */
export function pspDate(value: string, where: string): string {
  const parsed = parseDate(value);
  if (parsed) return parsed;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (slash) {
    // Ist der erste Teil größer als 12, ist es sicher Tag/Monat; sonst gilt die europäische Reihenfolge
    const [a, b] = [Number(slash[1]), Number(slash[2])];
    const [day, month] = b > 12 ? [b, a] : [a, b];
    const date = parseDate(`${day}.${month}.${slash[3]}`);
    if (date) return date;
  }
  throw new StatementParseError(`Ungültiges Datum „${value}“ (${where}).`);
}

export function skippedWarning(count: number, what: string): string[] {
  return count === 0 ? [] : [`${count} ${count === 1 ? "Zeile" : "Zeilen"} übersprungen: ${what}.`];
}

// PayPal ---------------------------------------------------------------------------------------------------------

export function isPayPalHeader(c: Columns): boolean {
  return (
    (c.has("brutto") && c.has("gebühr") && c.has("netto") && c.has("transaktionscode")) ||
    (c.has("gross") && c.has("fee") && c.has("net") && c.has("transactionid"))
  );
}

type PayPalSkip = "memo" | "hold" | "pending" | "foreign";

/**
 * Einbehaltung und ihre Rückbuchung: PayPal reserviert einen Betrag im Guthaben (bei einer Zahlung aus dem Guthaben die
 * „Einbehaltung für offene Autorisierung“, oft „Ausstehend“, aber mit Wirkung „Soll“) und gibt ihn mit der „Rückbuchung
 * allgemeiner Einbehaltung“ wieder frei; Geld fließt nur mit der Zahlung selbst (Juli-Fall im Issue #2025: 116,00 →
 * 110,81 → Zahlung 105,62 → Rückbuchung 110,81). Beide fallen immer weg, gleich welcher Status, damit keine Hälfte des
 * Paares allein stehen bleibt. Die Rückbuchung (T1105) hebt auch die allgemeine Einbehaltung (T1500) auf, deshalb fällt
 * diese mit; Namen nach der T-Code-Tabelle von PayPal (https://developer.paypal.com/reports/reference/t-codes). hledger
 * verwirft das Paar ebenso (`examples/csv/other/paypal-json.rules`, T1501 und T1105).
 */
const PAYPAL_HOLD =
  /^(einbehaltung für offene autorisierung|allgemeine einbehaltung|rückbuchung allgemeiner einbehaltung|account hold for open authorization|general account hold|reversal of general account hold)$/i;

/**
 * Bankgutschrift zu einer Zahlung per Lastschrift: PayPal lässt sie im Export „Ausstehend“, sie gleicht das Guthaben aber
 * aus (Wirkung „Haben“) und ist das Gegenstück der Lastschrift auf dem Bankkonto, also Geldtransit (#2025). Beleg: der
 * Beispiel-Export in hledger (`examples/csv/other/paypal-custom.csv`, „Bank Deposit to PP Account“ mit „Pending“, die Spalte
 * „Balance“ geht damit von −6,99 auf 0,00 zurück) und das Beispiel im Issue.
 */
function isBankFunding(type: string, impact: string): boolean {
  return /^(haben|credit)$/i.test(impact) && /^(bankgutschrift auf paypal-konto|bank deposit to pp account)/i.test(type);
}

/** Warum eine Zeile des Aktivitätenexports kein Umsatz ist; `undefined` heißt übernehmen */
function payPalSkip(type: string, impact: string, status: string, currency: string): PayPalSkip | undefined {
  // „Auswirkung auf Guthaben“ bzw. „Balance Impact“ = Memo: eine Vormerkung, die das Guthaben nicht ändert, etwa die
  // „Allgemeine Autorisierung“ neben der eigentlichen Zahlung (#2025). Fehlt die Spalte, ist der Wert leer.
  if (/^memo$/i.test(impact)) return "memo";
  // Ohne die Spalte bleibt auch die abgeschlossene Autorisierung als Abgang stehen; die Rückbuchung gleicht sie dann aus,
  // deshalb fällt das Paar nur mit Angabe der Wirkung weg (sonst wie vor #2025)
  if (impact && PAYPAL_HOLD.test(type)) return "hold";
  const pendingFunding = /^(ausstehend|pending)$/i.test(status) && isBankFunding(type, impact);
  if (!/^(abgeschlossen|completed)$/i.test(status) && !pendingFunding) return "pending";
  if (currency.toUpperCase() !== "EUR") return "foreign";
  return undefined;
}

/**
 * Aktivitätenexport von PayPal (Spalten deutsch oder englisch): Zeilen in Euro, die das Guthaben ändern, abgeschlossen oder
 * die ausstehende Bankgutschrift zu einer Lastschrift, ohne Einbehaltungen und ihre Rückbuchung
 */
export function parsePayPal(rows: string[][], headerRow: number): ParsedStatement {
  const c = new Columns(rows[headerRow]!);
  const german = c.has("brutto");
  const amount = (raw: string) => (german ? parseGermanAmount(raw) : parseDotAmount(raw));
  const date = c.getter("datum", "date");
  const name = c.getter("name");
  const type = c.getter("typ", "type");
  const status = c.getter("status");
  const impact = c.getter("auswirkungaufguthaben", "balanceimpact");
  const currency = c.getter("währung", "currency");
  const gross = c.getter("brutto", "gross");
  const fee = c.getter("gebühr", "fee");
  const id = c.getter("transaktionscode", "transactionid");
  const invoice = c.getter("rechnungsnummer", "invoicenumber");
  const subject = c.getter("betreff", "subject", "artikelbezeichnung", "itemtitle");

  const list: Tx[] = [];
  const skipped: Record<PayPalSkip, number> = { memo: 0, hold: 0, pending: 0, foreign: 0 };
  rows.slice(headerRow + 1).forEach((row, i) => {
    if (isBlankRow(row)) return;
    const where = `Zeile ${headerRow + i + 2}`;
    const skip = payPalSkip(type(row), impact(row), status(row), currency(row));
    if (skip) {
      skipped[skip]++;
      return;
    }
    const code = id(row);
    const purpose = [normalizeText(type(row)), normalizeText(invoice(row)), normalizeText(subject(row)), code].filter(Boolean).join(" · ");
    const bookingDate = pspDate(date(row), where);
    const grossAmount = requireAmount(amount(gross(row)), gross(row), where);
    const feeAmount = fee(row) ? requireAmount(amount(fee(row)), fee(row), where) : 0;
    if (grossAmount !== 0) {
      list.push({
        bookingDate,
        amount: grossAmount,
        currency: "EUR",
        counterpartyName: normalizeText(name(row)),
        purpose,
        type: normalizeText(type(row)) || undefined,
        bankReference: code || undefined,
      });
    }
    // PayPal schreibt die Gebühr mit Vorzeichen („-1,20“), bei Erstattungen kann sie positiv sein
    if (feeAmount !== 0) {
      list.push({
        bookingDate,
        amount: feeAmount,
        currency: "EUR",
        counterpartyName: "PayPal",
        purpose: `Gebühr · ${code}`,
        type: "Gebühr",
        bankReference: code ? `${code}-gebuehr` : undefined,
      });
    }
  });
  return finish({
    format: "paypal-csv",
    currency: "EUR",
    transactions: indexed(list),
    warnings: [
      ...skippedWarning(skipped.memo, "Vormerkung ohne Wirkung auf das Guthaben (Memo)"),
      ...skippedWarning(skipped.hold, "Einbehaltung und ihre Rückbuchung (nur eine Reservierung im Guthaben)"),
      ...skippedWarning(skipped.pending, "nicht abgeschlossen (ausstehend, abgelehnt, storniert)"),
      ...skippedWarning(skipped.foreign, "nicht in Euro"),
    ],
  });
}

// Stripe ---------------------------------------------------------------------------------------------------------

export function isStripeHeader(c: Columns): boolean {
  return (
    !c.has("payoutid") &&
    (c.has("amount") || c.has("gross")) &&
    c.has("fee") &&
    c.has("net") &&
    (c.has("availableon") || c.has("reportingcategory") || c.has("balancetransactionid"))
  );
}

/**
 * Zahlungen ohne Kunde und ohne Beschreibung haben keine Gegenpartei; Stripe füllt beides nur, wenn der Bericht die Spalten
 * enthält. Empfohlen werden nur die Kundenspalten: Der Name steht nicht im Dedup-Hash, der Zweck (mit der Beschreibung)
 * schon, ein neuer Zweck legte einen schon importierten Zeitraum ein zweites Mal an.
 */
function stripeUnnamedWarning(count: number): string[] {
  if (count === 0) return [];
  return [
    `${count} ${count === 1 ? "Zahlung hat" : "Zahlungen haben"} weder Kunde noch Beschreibung, deshalb ohne Name. Wähle beim Erstellen des Berichts in Stripe unter „Spalten“ zusätzlich customer_name und customer_email.`,
  ];
}

/** Saldenverlauf von Stripe („Balance history“, alter und neuer Export), nur Euro */
export function parseStripe(rows: string[][], headerRow: number): ParsedStatement {
  const c = new Columns(rows[headerRow]!);
  const id = c.getter("balancetransactionid", "id");
  const type = c.getter("reportingcategory", "type");
  const created = c.getter("createdutc", "created");
  const gross = c.getter("gross", "amount");
  const fee = c.getter("fee");
  const currency = c.getter("currency");
  const description = c.getter("description");
  // Der alte Saldenverlauf hat keine Kundenspalte; dann steht der Kunde meist in der Beschreibung
  const customerName = c.getter("customername");
  const customerEmail = c.getter("customeremail");
  // Der Hinweis rät, die Kundenspalten zu wählen: nur sinnvoll, solange der Bericht keine hat (leer ist bei einer Gast-Zahlung normal)
  const hatKundenspalten = c.has("customername", "customeremail");
  const customer = (row: string[]) => customerName(row) || customerEmail(row);

  const list: Tx[] = [];
  let foreign = 0;
  let unnamed = 0;
  rows.slice(headerRow + 1).forEach((row, i) => {
    if (isBlankRow(row)) return;
    const where = `Zeile ${headerRow + i + 2}`;
    if (currency(row).toUpperCase() !== "EUR") {
      foreign++;
      return;
    }
    const code = id(row);
    const kind = normalizeText(type(row));
    const bookingDate = pspDate(created(row), where);
    const grossAmount = requireAmount(parseDotAmount(gross(row)), gross(row), where);
    const feeAmount = fee(row) ? requireAmount(parseDotAmount(fee(row)), fee(row), where) : 0;
    const payout = /^payout/i.test(kind);
    if (!hatKundenspalten && /^(charge|payment)$/i.test(kind) && grossAmount !== 0 && !normalizeText(description(row))) unnamed++;
    if (grossAmount !== 0) {
      list.push({
        bookingDate,
        amount: grossAmount,
        currency: "EUR",
        counterpartyName: payout ? "Stripe" : normalizeText(customer(row)) || normalizeText(description(row)),
        purpose: [kind, normalizeText(description(row)), code].filter(Boolean).join(" · "),
        type: kind || undefined,
        bankReference: code || undefined,
      });
    }
    // Stripe weist die Gebühr positiv aus und zieht sie vom Betrag ab
    if (feeAmount !== 0) {
      list.push({
        bookingDate,
        amount: -feeAmount,
        currency: "EUR",
        counterpartyName: "Stripe",
        purpose: `Gebühr · ${code}`,
        type: "Gebühr",
        bankReference: code ? `${code}-gebuehr` : undefined,
      });
    }
  });
  return finish({
    format: "stripe-csv",
    currency: "EUR",
    transactions: indexed(list),
    warnings: [...skippedWarning(foreign, "nicht in Euro"), ...stripeUnnamedWarning(unnamed)],
  });
}

// Shopify Payments -----------------------------------------------------------------------------------------------

export function isShopifyHeader(c: Columns): boolean {
  return c.has("payoutid") && c.has("payoutdate") && c.has("amount") && c.has("fee") && c.has("net");
}

/**
 * Transaktionsexport von Shopify Payments. Auszahlungen stehen dort nicht als eigene Zeile, nur als Auszahlungs-ID an den
 * Transaktionen. Haben bildet je ausgezahlter Transaktion einen Auszahlungsumsatz über deren Nettobetrag am Auszahlungstag
 * (Referenz „payout-ID|…“). So bleibt die Auszahlung richtig, auch wenn sie über zwei Exporte (Monatsgrenze) verteilt ist
 * oder sich Exporte überschneiden; im Bankabgleich gehören alle Teile mit derselben ID zu einem Eingang auf der Bank.
 */
export function parseShopify(rows: string[][], headerRow: number): ParsedStatement {
  const c = new Columns(rows[headerRow]!);
  const date = c.getter("transactiondate");
  const type = c.getter("type");
  const order = c.getter("order");
  const payoutStatus = c.getter("payoutstatus");
  const payoutDate = c.getter("payoutdate");
  const payoutId = c.getter("payoutid");
  const amount = c.getter("amount");
  const fee = c.getter("fee");
  const net = c.getter("net");
  const currency = c.getter("currency");

  const list: Tx[] = [];
  let foreign = 0;
  rows.slice(headerRow + 1).forEach((row, i) => {
    if (isBlankRow(row)) return;
    const where = `Zeile ${headerRow + i + 2}`;
    if (currency(row).toUpperCase() !== "EUR") {
      foreign++;
      return;
    }
    const kind = normalizeText(type(row));
    const orderName = normalizeText(order(row));
    const bookingDate = pspDate(date(row), where);
    const grossAmount = requireAmount(parseDotAmount(amount(row)), amount(row), where);
    const feeAmount = fee(row) ? requireAmount(parseDotAmount(fee(row)), fee(row), where) : 0;
    const netAmount = requireAmount(parseDotAmount(net(row)), net(row), where);
    const ref = [orderName, kind, bookingDate, String(grossAmount)].join("|");
    if (grossAmount !== 0) {
      list.push({
        bookingDate,
        amount: grossAmount,
        currency: "EUR",
        counterpartyName: orderName ? `Bestellung ${orderName}` : "Shopify Payments",
        // Ohne Auszahlungs-ID: die gibt es erst nach der Auszahlung, sonst ergäbe derselbe Umsatz vorher und nachher zwei Hashes
        purpose: [kind, orderName ? `Bestellung ${orderName}` : ""].filter(Boolean).join(" · "),
        type: kind || undefined,
        bankReference: ref,
      });
    }
    if (feeAmount !== 0) {
      list.push({
        bookingDate,
        amount: -feeAmount,
        currency: "EUR",
        counterpartyName: "Shopify Payments",
        purpose: `Gebühr · ${[kind, orderName ? `Bestellung ${orderName}` : ""].filter(Boolean).join(" · ")}`,
        type: "Gebühr",
        bankReference: `${ref}|gebuehr`,
      });
    }
    const id = payoutId(row);
    if (id && netAmount !== 0 && /^paid$|^bezahlt$|^ausgezahlt$/i.test(payoutStatus(row))) {
      list.push({
        bookingDate: pspDate(payoutDate(row), where),
        amount: -netAmount,
        currency: "EUR",
        counterpartyName: "Shopify Payments",
        purpose: [`Auszahlung ${id}`, kind, orderName ? `Bestellung ${orderName}` : "", bookingDate].filter(Boolean).join(" · "),
        type: "Auszahlung",
        bankReference: `payout-${id}|${ref}`,
      });
    }
  });
  list.sort((a, b) => a.bookingDate.localeCompare(b.bookingDate));
  return finish({ format: "shopify-payments-csv", currency: "EUR", transactions: indexed(list), warnings: skippedWarning(foreign, "nicht in Euro") });
}
