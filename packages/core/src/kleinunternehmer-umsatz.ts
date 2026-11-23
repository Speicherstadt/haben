import type { Cents } from "./money.ts";

// Beträge in Cent. § 19 Abs. 1 UStG: Überschreiten, nicht Erreichen.
// https://www.gesetze-im-internet.de/ustg_1980/__19.html
export const VORJAHRESGRENZE = 2_500_000;
export const JAHRESGRENZE = 10_000_000;

/** UStAE 19.1 Abs. 3: Im Kalenderjahr der Tätigkeitsaufnahme gelten 25.000 €. */
export function kleinunternehmerJahresgrenze(datum: string, foundedOn: string | null) {
  const gruendungsjahr = datum.slice(0, 4) === foundedOn?.slice(0, 4);
  return { gruendungsjahr, jahresgrenze: gruendungsjahr ? VORJAHRESGRENZE : JAHRESGRENZE };
}

/** Vorwarnung ab vier Fünfteln der Grenze. */
export function umsatzgrenzeNahe(umsatz: Cents, grenze: Cents): boolean {
  return umsatz * 5 >= grenze * 4;
}
