import { type FbMappedVoucher, mapFbInvoice } from "./map.ts";
import type { FbInvoice } from "./types.ts";

/*
 * Einnahmen aus revenue.get (#1938): Belege, die man in FastBill unter „Einnahmen“ erfasst statt sie als Rechnung zu
 * schreiben, etwa die Gutschrift einer Plattform. invoice.get liefert sie nicht. Die Antwort hat die Felder einer Rechnung
 * (https://apidocs.fastbill.com/fastbill/de/revenue.html); im echten Konto (November 2026) kam nur TYPE incoming_credit.
 * Im Altbestand sind sie Einnahmebelege wie die aus der Buchhaltung von Lexoffice: salesinvoice, negativ salescreditnote.
 */

/** Nur incoming_credit ist belegt; eine andere Art (auch ein Entwurf) wird nicht geraten, sondern im Lauf gemeldet */
export function isFbRevenueImportable(r: FbInvoice): boolean {
  return (
    String(r.TYPE ?? "")
      .trim()
      .toLowerCase() === "incoming_credit"
  );
}

export function mapFbRevenue(r: FbInvoice): FbMappedVoucher {
  // Wie eine Rechnung, aber nie als Gutschrift von uns (TYPE credit) und ohne Storno-Bezug; das Vorzeichen bleibt
  const { voucher, payment } = mapFbInvoice({ ...r, TYPE: "outgoing", SUBTYPE: "standard" });
  return {
    voucher: { ...voucher, lexofficeId: `fastbill/revenue/${String(r.INVOICE_ID)}`, type: voucher.gross < 0 ? "salescreditnote" : "salesinvoice" },
    payment,
  };
}
