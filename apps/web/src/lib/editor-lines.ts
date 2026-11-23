// Positionen im Editor von Rechnung und Angebot: Eingabestand je Zeile und seine Prüfung (InvoiceEditor.tsx)
import {
  amountError,
  DISCOUNT_AMOUNT_MAX,
  discountInput,
  formatDecimal,
  formatQuantity,
  LINE_DESCRIPTION_MAX,
  LINE_QUANTITY_MAX,
  LINE_UNIT_PRICE_MAX,
  lineDiscountProblem,
  parseDiscount,
  parseEuro,
  parseQuantity,
  type Discount,
  type InvoiceLineInput,
  type QuoteLineKind,
} from "@haben/core";
import type { DraftInput } from "../server/modules/rechnungen/index.ts";

export interface LineState {
  key: number;
  description: string;
  /** Mehrzeilige Beschreibung unter der Bezeichnung */
  detail: string;
  /** Artikelnummer (BT-155), aus dem Artikel kopiert und änderbar */
  itemNumber: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxRate: 1900 | 700 | 0;
  /** Positionsrabatt wie eingegeben, „10 %“ oder „50,00“ */
  discount: string;
  /** Nur im Angebot: optional oder Alternative zur Hauptposition davor */
  kind: QuoteLineKind | null;
  /** Arbeits-, Maschinen- und Fahrtkosten (§ 35a EStG, #712), aus dem Artikel vorbelegt */
  arbeitskosten: boolean;
}

/** Position im Entwurf; im Angebot zusätzlich die Art */
export type EditorLine = DraftInput["lines"][number] & { kind?: QuoteLineKind | null };

let nextKey = 1;

/** Bezeichnungen vergleichen, ohne dass Zeilenumbrüche und doppelte Leerzeichen zählen */
export const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

export function toLineState(line: EditorLine): LineState {
  return {
    key: nextKey++,
    description: line.description,
    detail: line.detail ?? "",
    itemNumber: line.itemNumber ?? "",
    quantity: formatQuantity(line.quantity),
    unit: line.unit,
    unitPrice: line.unitPrice === 0 ? "" : formatDecimal(line.unitPrice),
    taxRate: line.taxRate,
    discount: discountInput(line.discount),
    kind: line.kind ?? null,
    arbeitskosten: line.arbeitskosten ?? false,
  };
}

/** Leere Zeile mit Einheit und Satz der letzten */
export const emptyLine = (unit: string, taxRate: 1900 | 700 | 0): LineState => ({
  key: nextKey++,
  description: "",
  detail: "",
  itemNumber: "",
  quantity: "1",
  unit,
  unitPrice: "",
  taxRate,
  discount: "",
  kind: null,
  arbeitskosten: false,
});

export type ParsedLine = InvoiceLineInput & {
  detail: string;
  itemNumber: string;
  discount: Discount | null;
  kind: QuoteLineKind | null;
  arbeitskosten: boolean;
  valid: boolean;
  discountError: boolean;
};

export function parseLine(line: LineState): ParsedLine {
  const quantity = parseQuantity(line.quantity);
  const unitPrice = parseEuro(line.unitPrice);
  const discount = parseDiscount(line.discount);
  const parsed = {
    description: line.description.trim(),
    detail: line.detail.trim(),
    itemNumber: line.itemNumber.trim(),
    quantity: quantity ?? 0,
    unit: line.unit,
    unitPrice: unitPrice ?? 0,
    taxRate: line.taxRate,
    discount: discount === "ungültig" ? null : discount,
    kind: line.kind,
    arbeitskosten: line.arbeitskosten,
  };
  const discountError = discount === "ungültig" || lineDiscountProblem(parsed) !== null;
  return {
    ...parsed,
    discountError,
    valid: quantity !== null && quantity > 0 && unitPrice !== null && line.description.trim() !== "" && !discountError,
  };
}

/** Felder einer Position mit eigener Prüfung, in der Reihenfolge der Tabelle */
export const POSITIONS_FELDER = ["beschreibung", "menge", "einzelpreis", "rabatt"] as const;
export type PositionsFeld = (typeof POSITIONS_FELDER)[number];

/** Schlüssel eines Felds der Position für useSubmitCheck */
export const positionsSchluessel = (key: number, feld: PositionsFeld) => `pos-${key}-${feld}`;

/** Was die Fehler einer Position braucht; ohne Rabatt (Serienrechnung) bleibt sein Fehler null */
type PositionsEingabe = Pick<LineState, "description" | "quantity" | "unitPrice"> & { discount?: string };

const PREIS_BEISPIEL = 9500;
const PREIS_GRENZE = amountError(`einen Einzelpreis von ${formatDecimal(-LINE_UNIT_PRICE_MAX)} bis ${formatDecimal(LINE_UNIT_PRICE_MAX)}`, PREIS_BEISPIEL);
const RABATT_UNLESBAR = "Rabatt als Prozent (z. B. 5 %) oder Betrag (z. B. 100,00).";

function beschreibungFehler(text: string): string | null {
  const beschreibung = text.trim();
  if (beschreibung === "") return "Trag die Beschreibung ein.";
  return beschreibung.length > LINE_DESCRIPTION_MAX ? `Kürz die Beschreibung auf höchstens ${LINE_DESCRIPTION_MAX} Zeichen.` : null;
}

function mengeFehler(text: string): string | null {
  const menge = parseQuantity(text);
  if (menge === null || menge <= 0) return "Trag eine Menge über 0 ein, etwa 2 oder 1,5.";
  return menge > LINE_QUANTITY_MAX ? `Trag eine Menge bis ${formatQuantity(LINE_QUANTITY_MAX)} ein.` : null;
}

function einzelpreisFehler(text: string): string | null {
  const preis = parseEuro(text);
  if (preis === null) return amountError("den Einzelpreis", PREIS_BEISPIEL);
  return Math.abs(preis) > LINE_UNIT_PRICE_MAX ? PREIS_GRENZE : null;
}

function rabattFehler(line: PositionsEingabe & { discount: string }): string | null {
  const discount = parseDiscount(line.discount);
  if (discount === "ungültig") return RABATT_UNLESBAR;
  const problem = lineDiscountProblem({ quantity: parseQuantity(line.quantity) ?? 0, unitPrice: parseEuro(line.unitPrice) ?? 0, discount });
  if (problem) return `${problem}.`;
  return discount?.kind === "betrag" && discount.value > DISCOUNT_AMOUNT_MAX
    ? `Trag einen Rabatt bis ${formatDecimal(DISCOUNT_AMOUNT_MAX)} ein oder gib ihn in Prozent an.`
    : null;
}

/**
 * Je Feld der Position der Fehler, der nur dieses Feld nennt, mit den Grenzen des Servers (invoiceLineInputSchema,
 * discountSchema); null, wo die Angabe stimmt. Die Meldungen stehen untereinander unter der Zeile (DESIGN.md, Gesperrte Knöpfe).
 */
export function positionsFehler(line: PositionsEingabe): Record<PositionsFeld, string | null> {
  return {
    beschreibung: beschreibungFehler(line.description),
    menge: mengeFehler(line.quantity),
    einzelpreis: einzelpreisFehler(line.unitPrice),
    rabatt: line.discount === undefined ? null : rabattFehler({ ...line, discount: line.discount }),
  };
}

/** Fehler aller Positionen, je Position und Feld ein Schlüssel (positionsSchluessel) */
export function positionenFehler(lines: readonly (PositionsEingabe & { key: number })[]): Record<string, string | null> {
  return Object.fromEntries(
    lines.flatMap((line) => {
      const fehler = positionsFehler(line);
      return POSITIONS_FELDER.map((feld) => [positionsSchluessel(line.key, feld), fehler[feld]]);
    }),
  );
}
