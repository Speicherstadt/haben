import { splitPrivateShare, taxIncluded, taxOf, type BasisPoints, type Cents, type Prozent } from "./money.ts";
import type { TaxShare } from "./steueranteile.ts";

/*
 * Beleg aus Positionen statt Beträgen je Steuersatz plus Aufteilung (#1975). Jede Position trägt ihren Steuersatz,
 * Netto, Steuer und ihren Privatanteil; daraus rechnet diese Schicht den betrieblichen Teil, die Summen je Satz und die
 * Entnahme. Sie nimmt die Positionen als Werte und kennt keine Tabelle, damit Datenmodell, Migration und Oberfläche
 * darauf aufsetzen können, ohne dass die Rechnung an einer von ihnen hängt.
 *
 * Abziehbar ist nur der betriebliche Teil (§ 15 Abs. 1 Satz 1 Nr. 1 UStG), bei gemischter Nutzung wird er aufgeteilt
 * (§ 15 Abs. 4 UStG); der private Teil ist eine Entnahme (§ 4 Abs. 1 Satz 2 und § 12 Nr. 1 EStG). Maßgeblich für die
 * Steuer je Satz ist der Betrag laut Rechnung (§ 14 Abs. 4 Nr. 8 UStG), deshalb lässt sich die Steuer einer Position
 * auf ihn korrigieren.
 *
 * Alles in Cent, ohne Gleitkomma und ohne Seiteneffekte. Dieselben Rechenwege wie in beleg-anteile.ts (#1924, #1926).
 */

/** Basis eines festen Privatanteils: netto = der Betrag ist netto, brutto = er enthält die Steuer der Position */
export type PrivateAmountBasis = "netto" | "brutto";

/**
 * Eine Position eines Belegs als Wert: Steuersatz, Netto und Steuer in Cent, dazu der Privatanteil. Kategorie,
 * Beschreibung und eigenes Konto werden nur mitgeführt; die Rechnung liest sie nicht, damit sie ohne Datenmodell
 * funktioniert (#1975).
 */
export interface BelegPosition {
  rate: BasisPoints;
  net: Cents;
  tax: Cents;
  /** Position „Privat“: der ganze Betrag ist privat, betrieblich bleibt 0 */
  privat?: boolean;
  /** Privatanteil in Prozent (100 = alles privat) */
  privateShare?: Prozent | null;
  /** Fester Privatanteil in Cent; hat Vorrang vor privateShare */
  privateAmount?: Cents | null;
  /** Basis von privateAmount; fehlt sie, gilt netto */
  privateAmountBasis?: PrivateAmountBasis | null;
  /** Index der Ausgangsposition, aus der eine Privat-Position per Prozent entstand */
  privateOf?: number | null;
  kategorie?: string;
  beschreibung?: string;
  konto?: string;
}

/** Betrieblicher Teil einer Position, in Cent */
export interface BetrieblichePosition {
  net: Cents;
  tax: Cents;
}

/** Betrieblicher Teil einer Position mit ihrem Index in der Liste */
export interface BetrieblicheZeile extends BetrieblichePosition {
  index: number;
  rate: BasisPoints;
}

/** Summen eines Belegs aus Positionen */
export interface PositionenSummen {
  /** Betrieblicher Teil je Position, in der Reihenfolge der Eingabe */
  zeilen: BetrieblicheZeile[];
  /** Betrieblich je Steuersatz, absteigend nach Satz */
  saetze: TaxShare[];
  net: Cents;
  tax: Cents;
  gross: Cents;
  /** Entnahme: der private Anteil aller Positionen, Netto und Steuer getrennt */
  privat: { net: Cents; tax: Cents; gross: Cents };
}

/** Begrenzt einen Anteil auf den Betrag der Position, mit demselben Vorzeichen */
function begrenzt(anteil: Cents, hoechstens: Cents): Cents {
  return hoechstens >= 0 ? Math.min(anteil, hoechstens) : Math.max(anteil, hoechstens);
}

/**
 * Privater Anteil einer Position in Netto und Steuer, in Cent.
 *
 * Eine Position „Privat“ ist ganz privat. Sonst gilt: ein gesetzter Betrag vor einem Prozentwert. Der Betrag ist die
 * genauere Angabe (etwa 12,99 € von der Rechnung abgelesen), der Prozentwert nur die Vorgabe der Kategorie; bleibt
 * beim Umschalten beides stehen, gewinnt der Betrag, damit die Rechnung eindeutig bleibt. Dieselbe Regel wie
 * privaterAnteil in #1926.
 *
 * Bei Basis brutto steckt die Steuer im Betrag und wird herausgerechnet, bei netto kommt sie hinzu; der Anteil ist auf
 * Netto und Steuer der Position begrenzt. Mehr privat als netto vorhanden gibt es nicht.
 */
export function privaterAnteil(position: BelegPosition): { net: Cents; tax: Cents } {
  if (position.privat) return { net: position.net, tax: position.tax };
  const amount = position.privateAmount;
  if (amount !== null && amount !== undefined) {
    const brutto = position.privateAmountBasis === "brutto";
    const net = brutto ? amount - taxIncluded(amount, position.rate) : amount;
    const tax = brutto ? amount - net : taxOf(net, position.rate);
    return { net: begrenzt(net, position.net), tax: begrenzt(tax, position.tax) };
  }
  const share = position.privateShare ?? 0;
  return { net: splitPrivateShare(position.net, share).private, tax: splitPrivateShare(position.tax, share).private };
}

/**
 * Betrieblicher Teil einer Position: Netto und Steuer abzüglich ihres privaten Anteils. Nur dieser Teil ist Aufwand
 * und vorsteuerabziehbar (§ 15 Abs. 1 Satz 1 Nr. 1 UStG), der private Teil ist Entnahme (§ 4 Abs. 1 Satz 2 EStG).
 */
export function betrieblichePosition(position: BelegPosition): BetrieblichePosition {
  const privat = privaterAnteil(position);
  return { net: position.net - privat.net, tax: position.tax - privat.tax };
}

type Zeile = BetrieblicheZeile & { privatNet: Cents; privatTax: Cents };

/** Setzt die Summe eines Feldes je Satz auf den Zielwert; den Rest trägt die betragsmäßig größte Position */
function aufZiel(zeilen: Zeile[], feld: "net" | "tax", ziel: Cents): void {
  const summe = zeilen.reduce((s, z) => s + z[feld], 0);
  if (summe === ziel) return;
  const groesste = zeilen.reduce((best, z) => (Math.abs(z.net) > Math.abs(best.net) ? z : best), zeilen[0]!);
  groesste[feld] += ziel - summe;
}

/**
 * Summen eines Belegs aus Positionen: betrieblich je Steuersatz und insgesamt, dazu die Entnahme in Netto und Steuer.
 *
 * Ohne vorgabe ist jede Summe die Summe der betrieblichen Teile ihrer Positionen, und betrieblich plus privat ergibt
 * genau die Positionen. Mit vorgabe (Netto und Steuer laut Rechnung je Satz, inklusive privatem Anteil) gilt deren
 * Betrag: betrieblich ist dann der Rest nach der Entnahme des Satzes. Die Differenz zu den Positionen trägt die
 * betragsmäßig größte Position des Satzes, wie beim Verteilen der Vorsteuer in allocateSplitTax und beim Steueranteil
 * einer Teilzahlung in paidTaxShares, damit die Summe centgenau aufgeht (§ 14 Abs. 4 Nr. 8 UStG).
 */
export function positionenSummen(positionen: readonly BelegPosition[], vorgabe: readonly TaxShare[] = []): PositionenSummen {
  const zeilen: Zeile[] = positionen.map((position, index) => {
    const betrieblich = betrieblichePosition(position);
    return {
      index,
      rate: position.rate,
      net: betrieblich.net,
      tax: betrieblich.tax,
      privatNet: position.net - betrieblich.net,
      privatTax: position.tax - betrieblich.tax,
    };
  });
  const je = new Map<BasisPoints, Zeile[]>();
  for (const zeile of zeilen) {
    const liste = je.get(zeile.rate);
    if (liste) liste.push(zeile);
    else je.set(zeile.rate, [zeile]);
  }
  for (const ziel of vorgabe) {
    const liste = je.get(ziel.rate);
    if (!liste) continue;
    aufZiel(liste, "net", ziel.base - liste.reduce((s, z) => s + z.privatNet, 0));
    aufZiel(liste, "tax", ziel.tax - liste.reduce((s, z) => s + z.privatTax, 0));
  }
  const saetze = [...je.entries()]
    .map(([rate, liste]) => ({
      rate,
      base: liste.reduce((s, z) => s + z.net, 0),
      tax: liste.reduce((s, z) => s + z.tax, 0),
    }))
    .sort((a, b) => b.rate - a.rate);
  const net = saetze.reduce((s, satz) => s + satz.base, 0);
  const tax = saetze.reduce((s, satz) => s + satz.tax, 0);
  const privatNet = zeilen.reduce((s, z) => s + z.privatNet, 0);
  const privatTax = zeilen.reduce((s, z) => s + z.privatTax, 0);
  return {
    zeilen: zeilen.map(({ index, rate, net: zeileNet, tax: zeileTax }) => ({ index, rate, net: zeileNet, tax: zeileTax })),
    saetze,
    net,
    tax,
    gross: net + tax,
    privat: { net: privatNet, tax: privatTax, gross: privatNet + privatTax },
  };
}

/**
 * Setzt die Steuer einer Position auf den Betrag der Rechnung. Maßgeblich ist der Steuerbetrag je Steuersatz laut
 * Rechnung (§ 14 Abs. 4 Nr. 8 UStG); die Summe gerundeter Zeilen weicht davon um Cents ab. Plausibel bleibt die Steuer
 * nur mit demselben Vorzeichen wie die Position (Storno bleibt negativ) und höchstens in Höhe ihres Bruttobetrags;
 * sonst null.
 */
export function steuerKorrektur(position: BelegPosition, steuer: Cents): BelegPosition | null {
  if (!Number.isSafeInteger(steuer)) return null;
  const brutto = position.net + position.tax;
  if (steuer !== 0 && Math.sign(steuer) !== Math.sign(brutto)) return null;
  if (Math.abs(steuer) > Math.abs(brutto)) return null;
  return { ...position, tax: steuer };
}

/**
 * Legt aus einer Ausgangsposition die Position „Privat“ an: der Prozentsatz wird auf Netto und Steuer der
 * Ausgangsposition angewandt (wie splitPrivateShare beim Buchen). Die Privat-Position trägt den Index ihrer
 * Ausgangsposition und den Prozentsatz, damit sie bei Änderungen nachgerechnet werden kann.
 */
export function privatPositionAusProzent(position: BelegPosition, prozent: Prozent, ausgangsIndex: number): BelegPosition {
  const anteil = (betrag: Cents) => splitPrivateShare(betrag, prozent).private;
  return {
    rate: position.rate,
    net: anteil(position.net),
    tax: anteil(position.tax),
    privat: true,
    privateShare: prozent,
    privateOf: ausgangsIndex,
    ...(position.beschreibung === undefined ? {} : { beschreibung: `${prozent} % von ${position.beschreibung}` }),
  };
}

/**
 * Rechnet eine per Prozent abgeleitete Privat-Position auf ihre geänderte Ausgangsposition nach. null, wenn die
 * Ausgangsposition wegfällt (dann fällt die Privat-Position mit weg) oder die Position keinen Verweis trägt (fester
 * Betrag, siehe privatPositionFesterBetrag).
 */
export function privatPositionNachrechnen(position: BelegPosition, neueAusgangsposition: BelegPosition | null | undefined): BelegPosition | null {
  if (!neueAusgangsposition || position.privateOf === null || position.privateOf === undefined) return null;
  const prozent = position.privateShare;
  if (prozent === null || prozent === undefined) return null;
  const anteil = (betrag: Cents) => splitPrivateShare(betrag, prozent).private;
  return {
    ...position,
    rate: neueAusgangsposition.rate,
    net: anteil(neueAusgangsposition.net),
    tax: anteil(neueAusgangsposition.tax),
  };
}

/**
 * Position „Privat“ mit festem Betrag ohne Verweis (#1926): Netflix vollständig privat auf derselben Rechnung wie das
 * anteilig genutzte Internet. Bei Basis brutto ist die Steuer der Rest, damit brutto centgenau aufgeht.
 */
export function privatPositionFesterBetrag(betrag: Cents, basis: PrivateAmountBasis, satz: BasisPoints): BelegPosition {
  const brutto = basis === "brutto";
  const net = brutto ? betrag - taxIncluded(betrag, satz) : betrag;
  const tax = brutto ? betrag - net : taxOf(net, satz);
  return { rate: satz, net, tax, privat: true, privateAmount: betrag, privateAmountBasis: basis };
}
