import { roundHalfAwayFromZero, splitPrivateShare, taxIncluded, taxOf, type BasisPoints, type Cents, type Prozent } from "./money.ts";
import { paidTaxShares, type TaxShare } from "./steueranteile.ts";

/*
 * Betrieblicher Anteil eines Belegs mit Privatanteil (#1914). Mit einem Anteil je Zeile ist nur der betriebliche Teil
 * jeder Zeile Aufwand und Vorsteuer. Gerechnet wird deshalb je Zeile und nicht über einen Anteil am Beleg: Netto und
 * Steuer einer Zeile werden getrennt gerundet (splitPrivateShare, wie beim Buchen), die betrieblichen Summen sind die
 * Summe dieser Zeilen. So trifft die Zeilensumme den Beleg centgenau, und ein voller Ausgleich lässt das Zwischenkonto
 * (SKR03 1548, SKR04 1434) auf null aufgehen.
 *
 * Seit #1926 trägt eine Zeile ihren Privatanteil auch als absoluten Betrag, wahlweise netto oder brutto: Netflix
 * vollständig privat auf derselben Telekom-Rechnung wie das anteilig genutzte Internet. Alles bleibt in Cent, ohne
 * Gleitkomma.
 *
 * Nur der betriebliche Teil ist vorsteuerabziehbar (§ 15 Abs. 1 Satz 1 Nr. 1 UStG); bei gemischter Nutzung wird er
 * aufgeteilt (§ 15 Abs. 4 UStG), der private Teil ist eine Entnahme (§ 4 Abs. 1 Satz 2 und § 12 Nr. 1 EStG).
 */

/** Basis eines absoluten Privatanteils: netto = der Betrag ist netto, brutto = er enthält die Steuer der Zeile */
export type PrivateAmountBasis = "netto" | "brutto";

/** Eine Zeile des Belegs mit ihrem Privatanteil: bei einer Aufteilung die Zeile aus document_splits, sonst ein Satz */
export interface BelegAnteilZeile {
  rate: BasisPoints;
  base: Cents;
  tax: Cents;
  privateShare: Prozent;
  /** Absoluter Privatanteil der Zeile in Cent (#1926); hat Vorrang vor privateShare */
  privateAmount?: Cents | null;
  /** Basis von privateAmount; fehlt sie, gilt netto */
  privateAmountBasis?: PrivateAmountBasis | null;
}

/** Begrenzt einen Anteil auf den Betrag der Zeile, mit demselben Vorzeichen */
function begrenzt(anteil: Cents, hoechstens: Cents): Cents {
  return hoechstens >= 0 ? Math.min(anteil, hoechstens) : Math.max(anteil, hoechstens);
}

/**
 * Privater Anteil einer Zeile in Netto und Steuer, in Cent; null, wenn die Zeile keinen Betrag trägt.
 *
 * Bei Basis brutto steckt die Steuer im Betrag und wird mit dem Satz der Zeile herausgerechnet (12,99 € brutto zu 19 %
 * sind 10,92 € netto und 2,07 € Steuer), bei netto kommt sie hinzu. Der Betrag ändert an der Aufteilung nichts:
 * abziehbar ist nur der betriebliche Teil (§ 15 Abs. 1 Satz 1 Nr. 1 UStG), bei gemischter Nutzung aufgeteilt nach
 * § 15 Abs. 4 UStG. Der Anteil ist auf Netto und Steuer der Zeile begrenzt: mehr privat als netto vorhanden gibt es
 * nicht. Ein gesetzter Betrag hat Vorrang vor einem gleichzeitig gesetzten Prozentwert; die Datenbank lässt beides
 * zusammen nicht zu, die Rechnung löst es trotzdem eindeutig.
 */
export function privaterAnteil(
  zeile: Pick<BelegAnteilZeile, "rate" | "base" | "tax" | "privateAmount" | "privateAmountBasis">,
): { net: Cents; tax: Cents } | null {
  const amount = zeile.privateAmount;
  if (amount === null || amount === undefined) return null;
  const brutto = zeile.privateAmountBasis === "brutto";
  const net = brutto ? amount - taxIncluded(amount, zeile.rate) : amount;
  const tax = brutto ? amount - net : taxOf(net, zeile.rate);
  return { net: begrenzt(net, zeile.base), tax: begrenzt(tax, zeile.tax) };
}

/**
 * Betrieblicher Teil eines Betrags, der auf diese Zeile entfällt, dazu ihr privater Teil. Bei Prozent wird der Betrag wie
 * bisher geteilt; bei einem absoluten Anteil nach dem Verhältnis der Zeile, damit auch eine Teilzahlung den privaten Teil
 * anteilig trägt. Der private Betrag der Zeile ist dabei schon auf Netto und Steuer begrenzt.
 */
export function betrieblicherAnteil(zeile: BelegAnteilZeile, base: Cents, tax: Cents): { base: Cents; tax: Cents; privatePart: Cents } {
  const privat = privaterAnteil(zeile);
  if (!privat) {
    const b = splitPrivateShare(base, zeile.privateShare);
    const t = splitPrivateShare(tax, zeile.privateShare);
    return { base: b.business, tax: t.business, privatePart: b.private + t.private };
  }
  const anteilig = (teil: Cents, privatTeil: Cents, ganz: Cents) => (ganz === 0 ? 0 : roundHalfAwayFromZero((teil * (ganz - privatTeil)) / ganz));
  const betrieblich = { base: anteilig(base, privat.net, zeile.base), tax: anteilig(tax, privat.tax, zeile.tax) };
  return { ...betrieblich, privatePart: base - betrieblich.base + tax - betrieblich.tax };
}

/** Betrieblicher Teil einer Zeile, Netto und Steuer getrennt gerundet, dazu ihr privater Teil */
export function betrieblicheZeile(zeile: BelegAnteilZeile): { rate: BasisPoints; base: Cents; tax: Cents; privatePart: Cents } {
  const b = betrieblicherAnteil(zeile, zeile.base, zeile.tax);
  return { rate: zeile.rate, base: b.base, tax: b.tax, privatePart: b.privatePart };
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
  return betrieblicheSaetze(
    anteile.map((anteil, i) => ({
      ...anteil,
      privateShare: zeilen[i]!.privateShare,
      privateAmount: zeilen[i]!.privateAmount ?? null,
      privateAmountBasis: zeilen[i]!.privateAmountBasis ?? null,
    })),
  );
}
