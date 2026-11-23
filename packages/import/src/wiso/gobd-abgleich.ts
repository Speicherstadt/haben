import type { Cents } from "@haben/core";
import { isBlankRow, parseCsv } from "../csv.ts";
import { decodeText } from "../decode.ts";
import { normalizeHeader, parseGermanAmount } from "../text.ts";
import { SALDOVORTRAG_ACCOUNTS } from "./parse.ts";
import { WisoParseError } from "./types.ts";

export interface WisoAccountTotals {
  openingDebit: Cents;
  openingCredit: Cents;
  movementDebit: Cents;
  movementCredit: Cents;
  /** Soll positiv, Haben negativ. */
  balance: Cents;
}

export interface WisoAccountDifference {
  account: string;
  fields: (keyof WisoAccountTotals)[];
  bookingList: WisoAccountTotals | null;
  trialBalance: WisoAccountTotals | null;
}

const FIELDS = ["openingDebit", "openingCredit", "movementDebit", "movementCredit", "balance"] as const;
const EMPTY: WisoAccountTotals = { openingDebit: 0, openingCredit: 0, movementDebit: 0, movementCredit: 0, balance: 0 };
const BOOKING_FIELDS = ["Konto", "Gegenkonto", "Betrag", "SollHaben"] as const;
const SUSA_FIELDS = ["KontoNummer", "AnfangssaldoSoll", "AnfangssaldoHaben", "BuchungsSummeSoll", "BuchungsSummeHaben", "SaldoSoll", "SaldoHaben"] as const;

type GoBdRow<Field extends string> = { line: number; values: Record<Field, string> };

function readGoBdRows<Field extends string>(bytes: Uint8Array, file: string, fields: readonly Field[]): GoBdRow<Field>[] {
  const records = parseCsv(decodeText(bytes), ";")
    .map((cells, i) => ({ cells, line: i + 1 }))
    .filter(({ cells }) => !isBlankRow(cells));
  if (records.length < 2) throw new WisoParseError(`${file}: Die Datei enthält keine Datenzeilen.`);
  const [header, ...rows] = records;
  const headerFields = header!.cells.map(normalizeHeader);
  const indices = fields.map((field) => {
    const key = normalizeHeader(field);
    const index = headerFields.indexOf(key);
    if (index === -1) throw new WisoParseError(`${file}: Spalte „${field}“ fehlt.`);
    if (index !== headerFields.lastIndexOf(key)) throw new WisoParseError(`${file}: Spalte „${field}“ ist mehrfach vorhanden.`);
    return [field, index] as const;
  });
  return rows.map(({ cells, line }) => ({
    line,
    values: Object.fromEntries(indices.map(([field, index]) => [field, cells[index]?.trim() ?? ""])) as Record<Field, string>,
  }));
}

function readAccount(raw: string, where: string, field: string) {
  if (!/^\d+$/.test(raw)) throw new WisoParseError(`${where}: Ungültige Kontonummer in ${field}.`);
  return raw.replace(/^0+(?=\d)/, "");
}

function readAmount(raw: string, where: string, field: string): Cents {
  const amount = parseGermanAmount(raw);
  if (amount === null) throw new WisoParseError(`${where}: Ungültiger Betrag in ${field}.`);
  return amount;
}

function safeCents(value: Cents, where: string): Cents {
  if (!Number.isSafeInteger(value)) throw new WisoParseError(`${where}: Die Summe überschreitet den unterstützten Betragsbereich.`);
  return value;
}

function bookingTotals(bytes: Uint8Array): Map<string, WisoAccountTotals> {
  const accounts = new Map<string, WisoAccountTotals>();
  for (const { line, values } of readGoBdRows(bytes, "GoBD-Buchungsliste", BOOKING_FIELDS)) {
    const where = `GoBD-Buchungsliste, Zeile ${line}`;
    const account = readAccount(values.Konto, where, "Konto");
    const contra = readAccount(values.Gegenkonto, where, "Gegenkonto");
    const side = values.SollHaben.toUpperCase();
    if (side !== "S" && side !== "H") throw new WisoParseError(`${where}: Ungültiger Wert in SollHaben.`);
    const opening = SALDOVORTRAG_ACCOUNTS.has(account) || SALDOVORTRAG_ACCOUNTS.has(contra);
    const field = opening ? (side === "S" ? "openingDebit" : "openingCredit") : side === "S" ? "movementDebit" : "movementCredit";
    const total = accounts.get(account) ?? { ...EMPTY };
    // Die GoBD-Datei enthält bereits je Konto eine Zeile, auch für Steuer und Gegenbuchung.
    total[field] = safeCents(total[field] + readAmount(values.Betrag, where, "Betrag"), where);
    accounts.set(account, total);
  }
  for (const [account, row] of accounts) {
    const where = `Konto ${account}`;
    const debit = safeCents(row.openingDebit + row.movementDebit, where);
    const credit = safeCents(row.openingCredit + row.movementCredit, where);
    row.balance = safeCents(debit - credit, where);
  }
  return accounts;
}

function trialBalanceTotals(bytes: Uint8Array): Map<string, WisoAccountTotals> {
  const accounts = new Map<string, WisoAccountTotals>();
  for (const { line, values } of readGoBdRows(bytes, "GoBD-SuSa", SUSA_FIELDS)) {
    const where = `GoBD-SuSa, Zeile ${line}`;
    const account = readAccount(values.KontoNummer, where, "KontoNummer");
    if (accounts.has(account)) throw new WisoParseError(`${where}: Konto ${account} steht mehrfach in der SuSa.`);
    const amount = (field: (typeof SUSA_FIELDS)[number]) => readAmount(values[field], where, field);
    accounts.set(account, {
      openingDebit: amount("AnfangssaldoSoll"),
      openingCredit: amount("AnfangssaldoHaben"),
      movementDebit: amount("BuchungsSummeSoll"),
      movementCredit: amount("BuchungsSummeHaben"),
      // Belegt im GoBD-Export EÜR & Kasse aus #565: Der Soll-Überhang steht in SaldoHaben und umgekehrt.
      balance: safeCents(amount("SaldoHaben") - amount("SaldoSoll"), where),
    });
  }
  return accounts;
}

/** Vergleicht zwei GoBD-Dateien. Schreibt weder Buchungen noch Archivdaten. */
export function compareWisoGoBd(bookings: Uint8Array, trialBalance: Uint8Array): { accounts: number; differences: WisoAccountDifference[] } {
  const booked = bookingTotals(bookings);
  const reported = trialBalanceTotals(trialBalance);
  const accounts = [...new Set([...booked.keys(), ...reported.keys()])].sort((a, b) => a.localeCompare(b, "de", { numeric: true }));
  const differences: WisoAccountDifference[] = [];
  for (const account of accounts) {
    const bookingList = booked.get(account) ?? null;
    const trialBalance = reported.get(account) ?? null;
    const fields = FIELDS.filter((field) => (bookingList?.[field] ?? 0) !== (trialBalance?.[field] ?? 0));
    if (fields.length > 0) differences.push({ account, fields, bookingList, trialBalance });
  }
  return { accounts: accounts.length, differences };
}
