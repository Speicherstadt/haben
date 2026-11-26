import { splitPrivateShare, type BasisPoints, type Cents, type Prozent } from "./money.ts";
import { paidTaxShares, type TaxShare } from "./steueranteile.ts";

/*
 * Betrieblicher Anteil eines Belegs mit Privatanteil (#1914). Mit einem Anteil je Zeile ist nur der betriebliche Teil
 * jeder Zeile Aufwand und Vorsteuer. Gerechnet wird deshalb je Zeile und nicht über einen Anteil am Beleg: Netto und
 * Steuer einer Zeile werden getrennt gerundet (splitPrivateShare, wie beim Buchen), die betrieblichen Summen sind die
 * Summe dieser Zeilen. So trifft die Zeilensumme den Beleg centgenau, und ein voller Ausgleich lässt das Zwischenkonto
 * (SKR03 1548, SKR04 1434) auf null aufgehen.
 */

/** Eine Zeile des Belegs mit ihrem Privatanteil: bei einer Aufteilung die Zeile aus document_splits, sonst ein Satz */
export interface BelegAnteilZeile {
  rate: BasisPoints;
  base: Cents;
  tax: Cents;
  privateShare: Prozent;
}

/** Betrieblicher Teil einer Zeile, Netto und Steuer getrennt gerundet, dazu ihr privater Teil */
export function betrieblicheZeile(zeile: BelegAnteilZeile): { rate: BasisPoints; base: Cents; tax: Cents; privatePart: Cents } {
  const base = splitPrivateShare(zeile.base, zeile.privateShare);
  const tax = splitPrivateShare(zeile.tax, zeile.privateShare);
  return { rate: zeile.rate, base: base.business, tax: tax.business, privatePart: base.private + tax.private };
}

/** Betrieblicher Teil je Steuersatz: die Summe der betrieblichen Zeilen, nicht der Anteil der Satzsumme */
export function betrieblicheSaetze(zeilen: readonly BelegAnteilZeile[]): TaxShare[] {
  const je = new Map<BasisPoints, TaxShare>();
  for (const zeile of zeilen) {
    const b = betrieblicheZeile(zeile);
    const bisher = je.get(zeile.rate);
    if (bisher) {
      bisher.base += b.base;
      bisher.tax += b.tax;
    } else je.set(zeile.rate, { rate: zeile.rate, base: b.base, tax: b.tax });
  }
  return [...je.values()].sort((a, b) => b.rate - a.rate);
}

/** Summen des betrieblichen Teils: Brutto ist Netto plus Steuer, nicht ein Anteil am Brutto des Belegs */
export function betrieblicheSummen(zeilen: readonly BelegAnteilZeile[]): { net: Cents; tax: Cents; gross: Cents; privatePart: Cents } {
  const saetze = betrieblicheSaetze(zeilen);
  const net = saetze.reduce((sum, s) => sum + s.base, 0);
  const tax = saetze.reduce((sum, s) => sum + s.tax, 0);
  const privatePart = zeilen.reduce((sum, zeile) => sum + betrieblicheZeile(zeile).privatePart, 0);
  return { net, tax, gross: net + tax, privatePart };
}

/**
 * Betrieblicher Anteil eines Zahlbetrags je Steuersatz. Der Betrag verteilt sich über die Zeilen wie bei einer
 * Teilzahlung (paidTaxShares, nach Brutto, den Rundungsrest trägt die größte Zeile); je Zeile fällt der private Anteil
 * weg. Kumuliert aufgerufen (Ziel dieses Betrags minus Ziel des vorigen Betrags) ergeben alle Zahlungen zusammen genau
 * Netto und Steuer der Zeilen; bei einem vollen Betrag sind das die Beträge, die beim Buchen auf dem Zwischenkonto stehen.
 */
export function betrieblicheZahlungsanteile(zeilen: readonly BelegAnteilZeile[], betrag: Cents): TaxShare[] {
  if (zeilen.length === 0) return [];
  const net = zeilen.reduce((sum, zeile) => sum + zeile.base, 0);
  const tax = zeilen.reduce((sum, zeile) => sum + zeile.tax, 0);
  const anteile = paidTaxShares({ net, tax, gross: net + tax, taxes: zeilen.map(({ rate, base, tax: steuer }) => ({ rate, base, tax: steuer })) }, betrag);
  return betrieblicheSaetze(anteile.map((anteil, i) => ({ ...anteil, privateShare: zeilen[i]!.privateShare })));
}
