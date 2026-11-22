import { footerColumns, legalLines } from "@haben/einvoice";
import { loadCompany } from "../stammdaten/index.ts";
import { sellerFrom } from "./invoice-document.ts";

/**
 * Für die Vorschau der Karte „Fußzeile“ (#1651): die automatische Fußzeile und die Pflichtangaben der Gesellschaft je
 * Angabe, so wie Haben sie aus den Firmendaten setzt; die eigenen Spalten füllt die Karte selbst
 */
export async function footerPreview(): Promise<{ automatic: string[][]; legal: string[] }> {
  const seller = sellerFrom(await loadCompany());
  return { automatic: footerColumns(seller), legal: legalLines(seller.legalInfo) };
}
