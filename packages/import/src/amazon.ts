import type { Cents } from "@haben/core";
import { finish, indexed, requireAmount, type Tx } from "./common.ts";
import { isBlankRow } from "./csv.ts";
import { StatementParseError } from "./errors.ts";
import { pspDate } from "./psp.ts";
import { Columns } from "./table.ts";
import { parseDotAmount, parseGermanAmount } from "./text.ts";
import type { ParsedStatement } from "./types.ts";

/*
 * Settlement-Report (Abrechnung) von Amazon: die Abrechnung eines Marktplatzes über einen Zeitraum (Seller Central ›
 * Berichte › Zahlungen, „Settlement Report“, Format GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2, Tab-getrennt). Die erste
 * Datenzeile ist die Zusammenfassung (settlement-id, Zeitraum, deposit-date, total-amount, currency); darunter steht jede
 * Position mit ihrem Betrag (amount), unterschieden in transaction-type, amount-type und amount-description. Der Aufbau
 * stammt aus einem echten amazon.de-Report (deutsche Formate: Komma-Beträge, TT.MM.JJJJ); englische Exporte schreiben
 * Punkt-Beträge und ISO-/US-Daten, deshalb liest der Parser beides.
 *
 * Haben fasst die Positionen einer Bestellung wie bei den übrigen Zahlungsdienstleistern zu zwei Umsätzen zusammen: dem
 * Erlös brutto (ItemPrice und Promotion, also Principal + Tax − Rabatt) und der einbehaltenen Gebühr (ItemFees). So lässt
 * sich der Erlös der Rechnung zuordnen (voller Erlös, Bruttoprinzip) und die Gebühr einer Gebührenrechnung. Sonderzeilen
 * (Abo-Gebühr, Lagergebühr, Erstattung, Rückstellung, Kontenausgleich) werden eigene Umsätze; unbekannte bleiben mit
 * Hinweis, statt zu raten, geht Haben die Zeile wegen des enthaltenen Betrags trotzdem mit. Die Auszahlung (total-amount
 * am deposit-date) ist ein negativer Umsatz und wird im Bankabgleich als Geldtransit mit dem Eingang verbunden.
 * Nur Euro: die Abrechnungswährung steht in der Kopfline, andere Marktplätze (GBP, PLN, SEK) lehnt Haben ab.
 */

/** Erkennt den Settlement-Report an seiner Kopfzeile */
export function isAmazonSettlementHeader(c: Columns): boolean {
  return c.has("settlementid") && c.has("transactiontype") && c.has("amounttype") && c.has("amountdescription") && c.has("totalamount");
}

/** Sonderzeilen (nicht zu einer Bestellung): Beschreibungen → Bezeichnung des Umsatzes */
const SPECIAL: [RegExp, string][] = [
  [/reimbursement|warehouse[_ ]?lost/i, "Erstattung"],
  [/fee|subscription|commission|fulfil|storage|ads/i, "Gebühr"],
];
const specialLabel = (amountType: string, description: string): string =>
  SPECIAL.find(([pattern]) => pattern.test(`${amountType} ${description}`))?.[1] ?? "Sonstiges";

/** Amazon schreibt deutsche („6,49“) und englische („6.49“) Beträge */
const amazonAmount = (raw: string): Cents | null => parseGermanAmount(raw) ?? parseDotAmount(raw);

/** Betrag lesbar melden */
const euros = (cents: Cents) => `${(cents / 100).toFixed(2).replace(".", ",")} €`;

/** Bestellung mit ihrem Erlös (brutto) und ihrer Gebühr */
interface OrderTotal {
  refund: boolean;
  date: string;
  revenue: Cents;
  fee: Cents;
}

/** Settlement-Report von Amazon (Tab-getrennt), nur Abrechnungen in Euro */
export function parseAmazonSettlement(rows: string[][], headerRow: number): ParsedStatement {
  const c = new Columns(rows[headerRow]!);
  const settlement = c.getter("settlementid");
  const start = c.getter("settlementstartdate");
  const end = c.getter("settlementenddate");
  const deposit = c.getter("depositdate");
  const total = c.getter("totalamount");
  const currency = c.getter("currency");
  const type = c.getter("transactiontype");
  const order = c.getter("orderid");
  const amountType = c.getter("amounttype");
  const description = c.getter("amountdescription");
  const amount = c.getter("amount");
  const marketplaceName = c.getter("marketplacename");
  const posted = c.getter("posteddate");

  const day = (raw: string, where: string) => pspDate(raw.trim().replace(/\s+\d{1,2}:\d{2}(?::\d{2})?.*$/, ""), where);
  const data = rows
    .slice(headerRow + 1)
    .map((row, i) => ({ row, line: headerRow + i + 2 }))
    .filter(({ row }) => !isBlankRow(row));

  // Kopfline: settlement-id und total-amount, aber keine Zeilenart
  const head = data.find(({ row }) => total(row) !== "" && type(row) === "");
  if (!head) throw new StatementParseError("Der Amazon-Settlement-Report nennt keinen Auszahlungsbetrag (Spalte total-amount fehlt).");
  const headCurrency = currency(head.row).toUpperCase() || "EUR";
  if (headCurrency !== "EUR") {
    throw new StatementParseError(
      `Der Amazon-Settlement-Report ist in ${headCurrency}. Haben übernimmt Abrechnungen nur in Euro (Marktplätze DE, FR, IT, ES, NL, BE, IE).`,
    );
  }
  const settlementId = settlement(head.row);
  const periodFrom = start(head.row) ? day(start(head.row), "Kopfline") : undefined;
  const periodTo = end(head.row) ? day(end(head.row), "Kopfline") : undefined;
  const payoutTotal = total(head.row) ? requireAmount(amazonAmount(total(head.row)), total(head.row), "Kopfline") : null;
  const payoutDate = (deposit(head.row) ? day(deposit(head.row), "Kopfline") : periodTo) ?? periodTo;

  const orders = new Map<string, OrderTotal>();
  const marketplaces = new Set<string>();
  const list: Tx[] = [];
  let positionSum = 0;
  for (const { row, line } of data) {
    if (row === head.row || type(row) === "") continue;
    const raw = amount(row);
    if (!raw) continue;
    const where = `Zeile ${line}`;
    const cents = requireAmount(amazonAmount(raw), raw, where);
    positionSum += cents;
    const kind = type(row);
    const orderId = order(row);
    if (marketplaceName(row)) marketplaces.add(marketplaceName(row));
    if ((kind === "Order" || kind === "Refund") && orderId) {
      const key = `${kind}|${orderId}`;
      const entry = orders.get(key) ?? { refund: kind === "Refund", date: day(posted(row), where), revenue: 0, fee: 0 };
      entry.date = day(posted(row), where);
      if (amountType(row) === "ItemFees") entry.fee += cents;
      else entry.revenue += cents; // ItemPrice, Promotion, ShippingCharge, GiftWrap …
      orders.set(key, entry);
      continue;
    }
    const at = amountType(row);
    const label = specialLabel(at, description(row));
    // Der Zweck nennt die Position; transaction-type entfällt, wenn er nur „other-transaction“ ist
    const names = [at, description(row)].filter((n) => n !== "" && n !== kind);
    list.push({
      bookingDate: day(posted(row), where),
      amount: cents,
      currency: "EUR",
      counterpartyName: "Amazon",
      purpose: [label, ...names].filter(Boolean).join(" · "),
      type: label,
      bankReference: [settlementId, kind, at, description(row)].filter(Boolean).join("|"),
    });
  }

  for (const [key, entry] of orders) {
    const value = key.slice(key.indexOf("|") + 1);
    const label = entry.refund ? "Erstattung" : "Verkauf";
    if (entry.revenue !== 0) {
      list.push({
        bookingDate: entry.date,
        amount: entry.revenue,
        currency: "EUR",
        counterpartyName: "Amazon",
        purpose: `${label} · Bestellung ${value}`,
        type: label,
        bankReference: [settlementId, entry.refund ? "Refund" : "Order", value].join("|"),
      });
    }
    if (entry.fee !== 0) {
      list.push({
        bookingDate: entry.date,
        amount: entry.fee,
        currency: "EUR",
        counterpartyName: "Amazon",
        purpose: `Gebühr · Bestellung ${value}`,
        type: "Gebühr",
        bankReference: [settlementId, entry.refund ? "Refund" : "Order", value, "gebuehr"].join("|"),
      });
    }
  }

  if (payoutTotal !== null && payoutTotal !== 0 && payoutDate) {
    list.push({
      bookingDate: payoutDate,
      amount: -payoutTotal,
      currency: "EUR",
      counterpartyName: "Amazon",
      purpose: `Auszahlung · Abrechnung ${settlementId}`,
      type: "Auszahlung",
      bankReference: ["amazon-payout", settlementId].join("|"),
    });
  }

  const warnings: string[] = [];
  if (payoutTotal !== null && positionSum !== payoutTotal) {
    warnings.push(`Die Summe der Positionen (${euros(positionSum)}) weicht vom Auszahlungsbetrag (${euros(payoutTotal)}) ab; bitte den Report prüfen.`);
  }
  const marketplace = marketplaces.size === 1 ? [...marketplaces][0] : undefined;
  if (marketplaces.size > 1) {
    warnings.push(`Die Abrechnung nennt mehrere Marktplätze (${[...marketplaces].join(", ")}); der Marktplatz wird nicht geprüft.`);
  }

  list.sort((a, b) => a.bookingDate.localeCompare(b.bookingDate));
  return finish({ format: "amazon-settlement", currency: "EUR", marketplace, periodFrom, periodTo, transactions: indexed(list), warnings });
}
