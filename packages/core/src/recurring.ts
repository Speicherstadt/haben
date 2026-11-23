import { type Recurrence, recurrenceParts } from "./recurrence.ts";

/**
 * Wiederkehrende Rechnungen: Intervall, nächstes Datum, Leistungszeitraum und Platzhalter im Text. Termine für
 * Rechnungen und Dauerbelege (dauerbeleg.ts) mit einer Dauer nach ISO 8601 (recurrence.ts, #1691).
 */
/**
 * Leistungszeitraum der Rechnung, in ganzen Kalendermonaten:
 * laufend = ab dem Monat des Rechnungsdatums (Vorauszahlung), vorher = die Monate davor (Abrechnung), keiner = ohne.
 */
export const SERVICE_PERIOD_MODES = {
  laufend: "Laufender Zeitraum (ab dem Rechnungsmonat)",
  vorher: "Vergangener Zeitraum (die Monate vor dem Rechnungsmonat)",
  keiner: "Kein Leistungszeitraum",
} as const;

export type ServicePeriodMode = keyof typeof SERVICE_PERIOD_MODES;

/** Bezeichnungen für ein Intervall: bei Wochen ab dem Rechnungsdatum bzw. die Wochen davor */
export function servicePeriodModes(recurrence: Recurrence): Record<ServicePeriodMode, string> {
  if (recurrenceParts(recurrence).weeks === null) return SERVICE_PERIOD_MODES;
  return {
    laufend: "Laufender Zeitraum (ab dem Rechnungsdatum)",
    vorher: "Vergangener Zeitraum (die Wochen vor dem Rechnungsdatum)",
    keiner: "Kein Leistungszeitraum",
  };
}

const iso = (year: number, monthIndex: number, day: number) => {
  const date = new Date(Date.UTC(year, monthIndex, day));
  return date.toISOString().slice(0, 10);
};

const daysInMonth = (year: number, monthIndex: number) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

/**
 * Datum plus Monate, am Ankertag: Tag 31 wird im Februar zum 28. (bzw. 29.) und im März wieder zum 31.
 */
export function addMonthsAnchored(date: string, months: number, anchorDay: number): string {
  const year = Number(date.slice(0, 4));
  const monthIndex = Number(date.slice(5, 7)) - 1 + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  return iso(targetYear, targetMonth, Math.min(anchorDay, daysInMonth(targetYear, targetMonth)));
}

export function servicePeriodFor(issueDate: string, interval: number, mode: ServicePeriodMode): { from: string; to: string } | null {
  if (mode === "keiner") return null;
  const year = Number(issueDate.slice(0, 4));
  const month = Number(issueDate.slice(5, 7)) - 1;
  const startMonth = mode === "laufend" ? month : month - interval;
  const startYear = year + Math.floor(startMonth / 12);
  const start = ((startMonth % 12) + 12) % 12;
  const endMonth = start + interval - 1;
  const endYear = startYear + Math.floor(endMonth / 12);
  const end = endMonth % 12;
  return { from: iso(startYear, start, 1), to: iso(endYear, end, daysInMonth(endYear, end)) };
}

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Termin nach dem angegebenen: Monate am Ankertag, Wochen plus 7, 14 oder 28 Tage */
export function nextRecurrenceDate(date: string, recurrence: Recurrence, anchorDay: number): string {
  return nthRecurrenceDate(date, recurrence, anchorDay, 1);
}

/** Der n-te Termin nach dem Start (n = 0: der Start), ohne Zwischenschritte: Monate am Ankertag, Wochen in Tagen */
export function nthRecurrenceDate(start: string, recurrence: Recurrence, anchorDay: number, n: number): string {
  const { weeks, months } = recurrenceParts(recurrence);
  return weeks === null ? addMonthsAnchored(start, months * n, anchorDay) : addDays(start, 7 * weeks * n);
}

/**
 * Leistungszeitraum einer Rechnung. Monate wie servicePeriodFor; Wochen: laufend = die Tage ab dem Rechnungsdatum,
 * vorher = die Tage bis zum Vortag.
 */
export function invoiceServicePeriod(issueDate: string, recurrence: Recurrence, mode: ServicePeriodMode): { from: string; to: string } | null {
  const { weeks, months } = recurrenceParts(recurrence);
  if (weeks === null) return servicePeriodFor(issueDate, months, mode);
  if (mode === "keiner") return null;
  const days = 7 * weeks;
  return mode === "laufend" ? { from: issueDate, to: addDays(issueDate, days - 1) } : { from: addDays(issueDate, -days), to: addDays(issueDate, -1) };
}

/** Alle fälligen Termine einer Rechnungsvorlage bis einschließlich heute, höchstens bis zum Enddatum */
export function recurrenceDueDates(nextDate: string, recurrence: Recurrence, anchorDay: number, today: string, endDate: string | null): string[] {
  return collectDueDates(nextDate, today, endDate, (date) => nextRecurrenceDate(date, recurrence, anchorDay));
}

const monthName = (date: string) => new Intl.DateTimeFormat("de-DE", { month: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

/** Platzhalter für Beschreibungen und Hinweis */
export const RECURRING_PLACEHOLDERS = {
  "{monat}": "Monat, z. B. November",
  "{jahr}": "Jahr, z. B. 2026",
  "{quartal}": "Quartal, z. B. Q4",
  "{zeitraum}": "Zeitraum, z. B. November 2026, Oktober – Dezember 2026 oder bei Wochen 23.11.2026 – 29.11.2026",
} as const;

/**
 * Ersetzt die Platzhalter. Bezug ist der Leistungszeitraum, ohne Leistungszeitraum das Rechnungsdatum.
 */
export function fillPlaceholders(text: string, reference: { from: string; to: string }): string {
  const fromYear = reference.from.slice(0, 4);
  const toYear = reference.to.slice(0, 4);
  const sameMonth = reference.from.slice(0, 7) === reference.to.slice(0, 7);
  const toYearNum = Number(toYear);
  const toMonthIndex = Number(reference.to.slice(5, 7)) - 1;
  // Ganze Monate (oder nur ein Datum) als Monatsnamen, Wochen mit Tagen
  const wholeMonths = reference.from.endsWith("-01") && Number(reference.to.slice(8, 10)) === daysInMonth(toYearNum, toMonthIndex);
  const day = (date: string) => date.split("-").reverse().join(".");
  const zeitraum =
    reference.from !== reference.to && !wholeMonths
      ? `${day(reference.from)} – ${day(reference.to)}`
      : sameMonth
        ? `${monthName(reference.from)} ${fromYear}`
        : fromYear === toYear
          ? `${monthName(reference.from)} – ${monthName(reference.to)} ${toYear}`
          : `${monthName(reference.from)} ${fromYear} – ${monthName(reference.to)} ${toYear}`;
  const quartal = `Q${Math.floor((Number(reference.from.slice(5, 7)) - 1) / 3) + 1}`;
  return text
    .replaceAll("{monat}", monthName(reference.from))
    .replaceAll("{jahr}", fromYear)
    .replaceAll("{quartal}", quartal)
    .replaceAll("{zeitraum}", zeitraum);
}

function collectDueDates(nextDate: string, today: string, endDate: string | null, next: (date: string) => string): string[] {
  const dates: string[] = [];
  let date = nextDate;
  while (date <= today && (!endDate || date <= endDate) && dates.length < 120) {
    dates.push(date);
    date = next(date);
  }
  return dates;
}
