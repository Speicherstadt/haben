import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectStatementFormat, PSP_FORMATS, parseStatement, StatementParseError, transactionHash, withDedupHashes } from "./index.ts";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../test-fixtures/${name}`, import.meta.url)));
const bytes = (text: string) => new TextEncoder().encode(text);
const sum = (total: number, t: { amount: number }) => total + t.amount;
const brief = (s: ReturnType<typeof parseStatement>) => s.transactions.map((t) => [t.bookingDate, t.amount, t.purpose]);

const HEADER = [
  "settlement-id",
  "settlement-start-date",
  "settlement-end-date",
  "deposit-date",
  "total-amount",
  "currency",
  "transaction-type",
  "order-id",
  "merchant-order-id",
  "adjustment-id",
  "shipment-id",
  "marketplace-name",
  "amount-type",
  "amount-description",
  "amount",
  "fulfillment-id",
  "posted-date",
  "posted-date-time",
  "order-item-code",
  "merchant-order-item-id",
  "merchant-adjustment-item-id",
  "sku",
  "quantity-purchased",
  "promotion-id",
].join("\t");

interface Row {
  type?: string;
  order?: string;
  marketplace?: string;
  amountType?: string;
  description?: string;
  amount?: string;
  date?: string;
  sku?: string;
}

function row(r: Row): string {
  const c = Array(24).fill("");
  c[0] = "10000000001";
  if (r.type) c[6] = r.type;
  if (r.order) {
    c[7] = r.order;
    c[8] = r.order;
  }
  if (r.marketplace) c[11] = r.marketplace;
  if (r.amountType) c[12] = r.amountType;
  if (r.description) c[13] = r.description;
  if (r.amount !== undefined) c[14] = r.amount;
  if (r.date) {
    c[16] = r.date;
    c[17] = `${r.date} 12:00:00 UTC`;
  }
  if (r.sku) c[21] = r.sku;
  return c.join("\t");
}

interface Head {
  total?: string;
  currency?: string;
  start?: string;
  end?: string;
  deposit?: string;
}

function file(rows: Row[], head: Head = {}): Uint8Array {
  const c = Array(24).fill("");
  c[0] = "10000000001";
  c[1] = `${head.start ?? "01.11.2026"} 00:00:00 UTC`;
  c[2] = `${head.end ?? "15.11.2026"} 00:00:00 UTC`;
  c[3] = `${head.deposit ?? "17.11.2026"} 00:00:00 UTC`;
  c[4] = head.total ?? "0,00";
  c[5] = head.currency ?? "EUR";
  return bytes([HEADER, c.join("\t"), ...rows.map(row)].join("\n"));
}

/*
 * Settlement-Report von Amazon (Seller Central › Berichte › Zahlungen, „Settlement Report“ V2, Tab-getrennt). Die erste
 * Datenzeile ist die Zusammenfassung der Abrechnung (Zeitraum, Auszahlungsbetrag, Währung); darunter steht jede Position
 * einzeln (amount mit amount-type und amount-description). Die Fixture ist aus einem echten amazon.de-Report anonymisiert
 * (Bestellnummern, SKUs, Settlement-ID ersetzt); die Beträge stimmen auf den Cent zum Auszahlungsbetrag.
 */
describe("Amazon-Settlement-Report", () => {
  it("erkennt die Datei und liest die Abrechnung", () => {
    const f = fixture("amazon-settlement.txt");
    expect(detectStatementFormat(f)).toBe("amazon-settlement");
    const s = parseStatement(f, "amazon-settlement.txt");
    expect(s.format).toBe("amazon-settlement");
    expect(s.currency).toBe("EUR");
    expect(s.marketplace).toBe("Amazon.de");
    expect([s.periodFrom, s.periodTo]).toEqual(["2026-11-03", "2026-11-17"]);
    // 15 Bestellungen zu je Erlös und Gebühr, 6 Sonderzeilen, die Auszahlung
    expect(s.transactions).toHaveLength(37);
    expect(s.transactions.reduce(sum, 0)).toBe(0);
    expect(s.warnings).toEqual([]);
  });

  it("verbucht die Auszahlung als negativen Umsatz am Auszahlungstag (Geldtransit)", () => {
    const s = parseStatement(fixture("amazon-settlement.txt"));
    expect(s.transactions.filter((t) => t.type === "Auszahlung").map((t) => [t.bookingDate, t.amount, t.purpose])).toEqual([
      ["2026-11-19", -993, "Auszahlung · Abrechnung 24681357900"],
    ]);
  });

  it("gruppiert jede Bestellung zu Erlös und Gebühr", () => {
    const s = parseStatement(fixture("amazon-settlement.txt"));
    const order = s.transactions.filter((t) => t.purpose.includes("Bestellung 101-0000000-0000001"));
    expect(order.map((t) => [t.type, t.amount, t.purpose])).toEqual([
      ["Verkauf", 649, "Verkauf · Bestellung 101-0000000-0000001"],
      ["Gebühr", -257, "Gebühr · Bestellung 101-0000000-0000001"],
    ]);
    // Erlöse und Gebühren getrennt summiert; die Sonderzeilen kommen als eigene Umsätze dazu
    expect(s.transactions.filter((t) => t.type === "Verkauf").reduce(sum, 0)).toBe(10350);
    expect(s.transactions.filter((t) => t.type === "Gebühr" && t.purpose.includes("Bestellung")).reduce(sum, 0)).toBe(-4689);
  });

  it("nimmt Erlös und Steuer zusammen (brutto) und zieht den Rabatt ab", () => {
    const s = parseStatement(
      file(
        [
          { type: "Order", order: "1-1", amountType: "ItemPrice", description: "Principal", amount: "4,87", date: "05.11.2026" },
          { type: "Order", order: "1-1", amountType: "ItemPrice", description: "Tax", amount: "0,92", date: "05.11.2026" },
          { type: "Order", order: "1-1", amountType: "Promotion", description: "Principal", amount: "-1,00", date: "05.11.2026" },
          { type: "Order", order: "1-1", amountType: "ItemFees", description: "Commission", amount: "-0,55", date: "05.11.2026" },
        ],
        { total: "4,24" },
      ),
    );
    expect(brief(s).filter(([, , purpose]) => !String(purpose).startsWith("Auszahlung"))).toEqual([
      ["2026-11-05", 479, "Verkauf · Bestellung 1-1"],
      ["2026-11-05", -55, "Gebühr · Bestellung 1-1"],
    ]);
    expect(s.transactions.map((t) => t.type)).toEqual(["Verkauf", "Gebühr", "Auszahlung"]);
  });

  it("liest eine Erstattung als Erstattung, ihre Gebührengutschrift bleibt eine Gebühr", () => {
    const s = parseStatement(
      file(
        [
          { type: "Refund", order: "2-2", amountType: "ItemPrice", description: "Principal", amount: "-8,00", date: "06.11.2026" },
          { type: "Refund", order: "2-2", amountType: "ItemFees", description: "Commission", amount: "0,68", date: "06.11.2026" },
        ],
        { total: "-7,32" },
      ),
    );
    expect(brief(s).filter(([, , purpose]) => !String(purpose).startsWith("Auszahlung"))).toEqual([
      ["2026-11-06", -800, "Erstattung · Bestellung 2-2"],
      ["2026-11-06", 68, "Gebühr · Bestellung 2-2"],
    ]);
    expect(s.transactions.map((t) => t.type)).toEqual(["Erstattung", "Gebühr", "Auszahlung"]);
  });

  it("ordnet die Sonderzeilen zu: Gebühr, Erstattung, Sonstiges", () => {
    const s = parseStatement(fixture("amazon-settlement.txt"));
    const special = s.transactions.filter((t) => !t.purpose.includes("Bestellung") && t.type !== "Auszahlung");
    expect(special.map((t) => [t.bookingDate, t.amount, t.type, t.purpose])).toEqual([
      ["2026-11-03", -119, "Sonstiges", "Sonstiges · Payable to Amazon"],
      ["2026-11-03", 119, "Sonstiges", "Sonstiges · Cross-Account Debt Adjustment against FR"],
      ["2026-11-07", -102, "Gebühr", "Gebühr · FBA Inventory Storage Fee · Base fee"],
      ["2026-11-07", -19, "Gebühr", "Gebühr · FBA Inventory Storage Fee · Tax on fee"],
      ["2026-11-09", -4641, "Gebühr", "Gebühr · Subscription Fee"],
      ["2026-11-17", 94, "Erstattung", "Erstattung · FBA Inventory Reimbursement · WAREHOUSE_LOST"],
    ]);
  });

  it("gibt den Marktplatz der Abrechnung mit", () => {
    const s = parseStatement(
      file(
        [{ type: "Order", order: "1-1", marketplace: "Amazon.fr", amountType: "ItemPrice", description: "Principal", amount: "10,00", date: "05.11.2026" }],
        {
          total: "10,00",
        },
      ),
    );
    expect(s.marketplace).toBe("Amazon.fr");
  });

  it("nennt die Abrechnung mehrere Marktplätze, wird der Marktplatz nicht geprüft", () => {
    const s = parseStatement(
      file(
        [
          { type: "Order", order: "1-1", marketplace: "Amazon.de", amountType: "ItemPrice", description: "Principal", amount: "10,00", date: "05.11.2026" },
          { type: "Order", order: "2-2", marketplace: "Amazon.fr", amountType: "ItemPrice", description: "Principal", amount: "5,00", date: "05.11.2026" },
        ],
        { total: "15,00" },
      ),
    );
    expect(s.marketplace).toBeUndefined();
    expect(s.warnings).toEqual(["Die Abrechnung nennt mehrere Marktplätze (Amazon.de, Amazon.fr); der Marktplatz wird nicht geprüft."]);
  });

  it("lehnt eine Abrechnung in fremder Währung ab (nur die EUR-Marktplätze)", () => {
    const f = file([{ type: "Order", order: "1-1", amountType: "ItemPrice", description: "Principal", amount: "10.00", date: "05.11.2026" }], {
      total: "10.00",
      currency: "GBP",
    });
    expect(() => parseStatement(f, "amazon-settlement.txt")).toThrow(StatementParseError);
    expect(() => parseStatement(f, "amazon-settlement.txt")).toThrow(/in GBP\. .*nur in Euro/);
  });

  it("warnt, wenn die Summe der Positionen vom Auszahlungsbetrag abweicht", () => {
    const s = parseStatement(
      file([{ type: "Order", order: "1-1", amountType: "ItemPrice", description: "Principal", amount: "10,00", date: "05.11.2026" }], { total: "9,00" }),
    );
    expect(s.transactions.reduce(sum, 0)).toBe(1000 - 900);
    expect(s.warnings).toEqual(["Die Summe der Positionen (10,00 €) weicht vom Auszahlungsbetrag (9,00 €) ab; bitte den Report prüfen."]);
  });

  it("bricht bei ungültigem Datum oder Betrag mit Zeilenangabe ab", () => {
    const bad = file([{ type: "Order", order: "1-1", amountType: "ItemPrice", description: "Principal", amount: "€abc", date: "05.11.2026" }], {
      total: "0,00",
    });
    expect(() => parseStatement(bad, "amazon.txt")).toThrow(/Ungültiger Betrag „€abc“ \(Zeile 3\)/);
    const badDate = file([{ type: "Order", order: "1-1", amountType: "ItemPrice", description: "Principal", amount: "1,00", date: "Sunday 99" }], {
      total: "0,00",
    });
    expect(() => parseStatement(badDate, "amazon.txt")).toThrow(/Ungültiges Datum „Sunday 99“ \(Zeile 3\)/);
  });

  it("gilt als Zahlungsdienstleister: nur in ein Konto mit diesem Zweck importierbar", () => {
    expect(PSP_FORMATS).toContain("amazon-settlement");
  });

  it("legt beim erneuten Import dieselben Dubletten-Hashes an, gleiche Zeilen bekommen verschiedene", () => {
    const s = parseStatement(fixture("amazon-settlement.txt"));
    const first = withDedupHashes(s.transactions).map((t) => t.dedupHash);
    const again = withDedupHashes(parseStatement(fixture("amazon-settlement.txt")).transactions).map((t) => t.dedupHash);
    expect(again).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    expect(first[0]).toBe(transactionHash(s.transactions[0]!, 0));
  });

  it("liest das Datum auch als ISO und die Beträge mit Dezimalpunkt (englischer Export)", () => {
    const s = parseStatement(
      file([{ type: "Order", order: "1-1", amountType: "ItemPrice", description: "Principal", amount: "10.00", date: "05.11.2026" }], { total: "10.00" }),
    );
    expect(brief(s)[0]).toEqual(["2026-11-05", 1000, "Verkauf · Bestellung 1-1"]);
  });
});
