import type { ScheduleYear } from "./afa.ts";
import type { Cents } from "./money.ts";

export interface SpecialDepreciationAmount {
  year: number;
  amount: Cents;
}

/** Betragsgrenze nach § 7g Abs. 5 und § 52 Abs. 16 EStG, auf volle Cent abgerundet. */
export function specialDepreciationLimit(acquisitionDate: string, basis: Cents): Cents {
  const tenths = acquisitionDate >= "2024-01-01" ? 4n : 2n;
  return Number((BigInt(basis) * tenths) / 10n);
}

/** Prüft die zeitliche Verteilung und den Gesamtbetrag nach § 7g Abs. 5 EStG. */
export function specialDepreciationIssues(acquisitionDate: string, basis: Cents, amounts: readonly SpecialDepreciationAmount[]): string[] {
  const firstYear = Number(acquisitionDate.slice(0, 4));
  const issues: string[] = [];
  if (amounts.some(({ year }) => !Number.isInteger(year) || year < firstYear || year > firstYear + 4)) {
    issues.push("Sonder-AfA nur im Anschaffungs- oder Herstellungsjahr und den vier Folgejahren");
  }
  if (new Set(amounts.map(({ year }) => year)).size !== amounts.length) {
    issues.push("Je Wirtschaftsjahr ist nur ein Sonder-AfA-Betrag möglich");
  }
  if (amounts.some(({ amount }) => !Number.isSafeInteger(amount) || amount < 0)) {
    issues.push("Sonder-AfA muss ein nicht negativer Betrag in vollen Cent sein");
  } else if (amounts.reduce((sum, { amount }) => sum + amount, 0) > specialDepreciationLimit(acquisitionDate, basis)) {
    issues.push("Gesamtbetrag der Sonder-AfA überschreitet die gesetzliche Obergrenze");
  }
  return issues;
}

/** Steuerliche Werte abzüglich Handelswerte. Der Restbuchwert beim Abgang zählt als Aufwand. */
export function specialDepreciationDifference(commercial: ScheduleYear, tax: ScheduleYear) {
  const depreciation = tax.depreciation + (tax.specialDepreciation ?? 0) - commercial.depreciation;
  const disposal = tax.disposal - commercial.disposal;
  return {
    opening: tax.opening - commercial.opening,
    depreciation,
    disposal,
    closing: tax.closing - commercial.closing,
    profit: -(depreciation + disposal),
  };
}
