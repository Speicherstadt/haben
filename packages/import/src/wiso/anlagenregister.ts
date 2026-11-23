import { type Cents, formatEuro } from "@haben/core";
import { parseDate, parseGermanAmount } from "../text.ts";
import { WisoParseError } from "./types.ts";

export interface WisoRegisterAsset {
  inventoryNumber: string;
  name: string;
  account: string;
  page: number;
  acquisitionDate: string;
  cost: Cents;
  usefulLifeYears: string;
  change: Cents | null;
  priorDepreciation: Cents;
  priorBookValue: Cents;
  annualDepreciation: Cents;
  closingBookValue: Cents;
  disposalDate: string | null;
}

// WISO EÜR & Kasse, Beispielexport Nr. 10 (pdftotext -layout):
// https://github.com/Speicherstadt/haben/issues/565#issuecomment-6770106423
const TITLE = /Verzeichnis der abnutzbaren Anlagegüter\s+(\d{4})/g;
const HEADER = /^\s*Nr\.?\s+Bezeichnung\s+Anschaffungs-\s+Anschaffungs-\s+Zugänge\s*\/\s+ND\s+AfA\s+RBW\s+AfA\s+RBW\s+Anlagen-/;
const DETAILS = /^\s*Anlagendetails\s+\d{4}\s*$/m;
const ACCOUNT = /^(\d{2,6})\s+\p{L}/u;
const DATE = String.raw`\d{2}\.\d{2}\.\d{4}`;
const ASSET_DATE = new RegExp(DATE);
const AMOUNT = String.raw`[+-]?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}-?`;
// Das Datum trennt auch eine lange, direkt anschließende Bezeichnung von den Zahlenspalten.
const ROW = new RegExp(
  String.raw`^\s*(?<id>\d+)\s+(?<name>.+?)(?<date>${DATE})\s+(?<cost>${AMOUNT})(?:\s+(?<change>${AMOUNT}))?\s+(?<life>\d+(?:,\d+)?)\s+` +
    String.raw`(?<priorDepreciation>${AMOUNT})\s+(?<priorBookValue>${AMOUNT})\s+(?<annualDepreciation>${AMOUNT})\s+(?<closingBookValue>${AMOUNT})(?:\s+(?<disposal>${DATE}))?\s*$`,
);

function amount(raw: string | undefined, where: string): Cents {
  const parsed = parseGermanAmount(raw ?? "");
  if (parsed === null) throw new WisoParseError(`${where}: ungültiger Betrag im Anlagenverzeichnis.`);
  return parsed;
}

function readAsset(line: string, account: string | null, page: number, where: string): WisoRegisterAsset {
  const values = ROW.exec(line)?.groups;
  const name = values?.name?.trim();
  if (!values || !name || !account) throw new WisoParseError(`${where}: Zeile im Anlagenverzeichnis nicht eindeutig lesbar.`);
  const acquisitionDate = parseDate(values.date!);
  const disposalDate = values.disposal ? parseDate(values.disposal) : null;
  if (!acquisitionDate || (values.disposal && !disposalDate)) throw new WisoParseError(`${where}: ungültiges Datum im Anlagenverzeichnis.`);
  return {
    account,
    page,
    inventoryNumber: values.id!,
    name,
    acquisitionDate,
    cost: amount(values.cost, where),
    usefulLifeYears: values.life!,
    change: values.change ? amount(values.change, where) : null,
    priorDepreciation: amount(values.priorDepreciation, where),
    priorBookValue: amount(values.priorBookValue, where),
    annualDepreciation: amount(values.annualDepreciation, where),
    closingBookValue: amount(values.closingBookValue, where),
    disposalDate,
  };
}

function checkSubtotal(line: string, account: string, rows: readonly WisoRegisterAsset[], where: string): string | null {
  const totals = line.trim().split(/\s+/).slice(1);
  if (totals.length !== 5 && totals.length !== 6) throw new WisoParseError(`${where}: Summenzeile im Anlagenverzeichnis nicht eindeutig lesbar.`);
  const columns = [
    ["cost", "Anschaffungskosten"],
    ["change", "Zugänge/Teilabgänge"],
    ["priorDepreciation", "Vorjahres-AfA"],
    ["priorBookValue", "Vorjahres-Restbuchwert"],
    ["annualDepreciation", "Jahres-AfA"],
    ["closingBookValue", "Restbuchwert 31.12."],
  ] as const;
  if (totals.length === 5) totals.splice(1, 0, "0,00");
  const differences = columns.flatMap(([key, label], index) => {
    const printed = amount(totals[index], where);
    const calculated = rows.reduce((total, row) => total + (row[key] ?? 0), 0);
    return printed === calculated ? [] : [`${label} ${formatEuro(calculated)} statt ${formatEuro(printed)}`];
  });
  return differences.length === 0 ? null : `Konto ${account}: Einzelzeilen und gedruckte Summe weichen ab (${differences.join(", ")}).`;
}

/** Liest nur die Werte aus dem Anlagenverzeichnis, ohne AfA-Art oder Haben-Kategorie abzuleiten. */
export function readWisoAssetRegister(pages: readonly string[]): { year: number; assets: WisoRegisterAsset[]; warnings: string[] } {
  const years = new Set(pages.flatMap((page) => [...page.matchAll(TITLE)].map((match) => Number(match[1]))));
  if (years.size !== 1) throw new WisoParseError("Kein eindeutiges WISO-Anlagenverzeichnis mit Abschlussjahr erkannt.");
  const [year] = years;
  const assets: WisoRegisterAsset[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let account: string | null = null;
  let groupStart = 0;
  for (const [i, text] of pages.entries()) {
    const page = i + 1;
    const printedPage = /^Unternehmen \/ Firma[^\n]*\s+Seite\s+(\d+)\s*$/m.exec(text)?.[1];
    if (printedPage && Number(printedPage) !== page)
      throw new WisoParseError(`Seite ${page}: WISO-Seitennummer ${printedPage} deutet auf fehlende Seiten hin.`);
    const lines = text.split(/\r?\n/);
    const header = lines.findIndex((line) => HEADER.test(line));
    if (header === -1 && DETAILS.test(text)) continue;
    if (header === -1 || !lines[header + 1]?.includes(`31.12.${year}`)) {
      throw new WisoParseError(`Seite ${page}: Spalten des WISO-Anlagenverzeichnisses nicht erkannt.`);
    }
    for (let index = header + 2; index < lines.length; index++) {
      const line = lines[index]!;
      const value = line.trim();
      const where = `Seite ${page}, Zeile ${index + 1}`;
      if (!value || value.startsWith("Soweit im Einzelnen nicht anders vermerkt")) continue;
      const group = ACCOUNT.exec(line)?.[1];
      if (group && !ASSET_DATE.test(line)) {
        if (account && account !== group) throw new WisoParseError(`${where}: Summenzeile für Konto ${account} fehlt.`);
        if (account !== group) groupStart = assets.length;
        account = group;
        continue;
      }
      if (value.startsWith("Summen ") && account) {
        const warning = checkSubtotal(line, account, assets.slice(groupStart), where);
        if (warning) warnings.push(warning);
        account = null;
        continue;
      }
      const asset = readAsset(line, account, page, where);
      if (seen.has(asset.inventoryNumber)) throw new WisoParseError(`${where}: Inventarnummer ${asset.inventoryNumber} steht mehrfach im Verzeichnis.`);
      seen.add(asset.inventoryNumber);
      if (asset.change || asset.disposalDate)
        warnings.push(`Inventarnummer ${asset.inventoryNumber}: Zugang, Teilabgang oder Abgang anhand der Anlagendetails prüfen.`);
      assets.push(asset);
    }
  }
  if (account) throw new WisoParseError(`Summenzeile für Konto ${account} fehlt.`);
  if (assets.length === 0 || year === undefined) throw new WisoParseError("Das WISO-Anlagenverzeichnis enthält keine lesbaren Anlagen.");
  return { year, assets, warnings };
}
