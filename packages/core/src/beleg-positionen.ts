import { belegAnteile } from "./beleg-anteile.ts";
import { allocateSplitTax, type DocumentRateAmount, type DocumentSplitLine } from "./document-split.ts";
import { formatEuro, taxIncluded, taxOf, type BasisPoints, type Cents, type Prozent } from "./money.ts";
import type { ExpenseCategory } from "./posting.ts";
import { netOf } from "./rabatt.ts";
import { isKapitalgesellschaft, type Rechtsform } from "./rechtsform.ts";
import type { TaxShare } from "./steueranteile.ts";

/*
 * Beleg aus Positionen statt Beträgen je Steuersatz (#1975). Maßgeblich ist die Steuer je Satz laut Rechnung: Sie wird
 * zuerst festgelegt und dann über allocateSplitTax nach Netto auf die Positionen des Satzes verteilt. Netto × Satz je
 * Position zu runden liefe gegen die Steuer der Rechnung auseinander und damit gegen Kz 66.
 *
 * Privat ist eine Kategorie, keine eigene Art: Was privat ist, erkennt die Rechnung an kategorie "privatentnahme".
 * Eine solche Position ist betrieblich genau 0, in Netto und Steuer. Der Anteil entsteht einmalig über
 * privatanteilAbspalten, das eine Position in den betrieblichen Teil und die Privatentnahme teilt; danach sind es
 * zwei gewöhnliche Positionen ohne Verbindung, nichts rechnet später nach. Ein fester Betrag (#1926) ist eine von
 * Hand angelegte Position privatentnahme; brutto reicht dafür saetzeAusBrutto.
 *
 * Brutto-Eingabe wird je Satz zusammengezählt und wie in computeInvoice in Netto und Steuer geteilt; das Entgelt nach
 * Steuersätzen aufgeschlüsselt samt Steuerbetrag verlangt § 14 Abs. 4 Nr. 8 UStG, erst danach wird es auf die
 * Positionen verteilt.
 *
 * Abziehbar ist nur der betriebliche Teil der ordnungsgemäßen Rechnung (§ 15 Abs. 1 Satz 1 Nr. 1 UStG), bei gemischter
 * Nutzung wird er aufgeteilt (§ 15 Abs. 4 UStG); eine zu hoch ausgewiesene Steuer schuldet der Aussteller nach § 14c
 * Abs. 1 UStG. Der private Teil ist eine Entnahme (§ 4 Abs. 1 Satz 2 und § 12 Nr. 1 EStG).
 *
 * Alles in Cent, ohne Gleitkomma und ohne Seiteneffekte.
 */

/** Kategorie der Privatentnahme; was privat ist, erkennt die Rechnung hieran */
const PRIVATENTNAHME = "privatentnahme";

/**
 * Eine Position eines Belegs als Wert: Kategorie, Steuersatz und Netto. Beschreibung und eigenes Konto werden nur
 * mitgeführt; die Rechnung liest sie nicht. Privat ist eine Position mit kategorie "privatentnahme", sie trägt
 * kein Konto des Betriebs. Die Steuer trägt die Position nicht selbst, sie kommt aus der Steuer ihres Satzes.
 */
export interface Position {
  kategorie: string;
  rate: BasisPoints;
  net: Cents;
  beschreibung?: string;
  konto?: string;
}

/** Bruttobetrag je Steuersatz, wie er auf der Rechnung steht */
export interface BruttoBetrag {
  rate: BasisPoints;
  gross: Cents;
}

/** Betrieblicher und privater Teil einer Position mit ihrem Index in der Liste */
export interface PositionenZeile {
  index: number;
  kategorie: string;
  rate: BasisPoints;
  /** Betriebliches Netto, bei einer Privatentnahme 0 */
  net: Cents;
  /** Betriebliche, aus dem Satz zugeteilte Steuer, bei einer Privatentnahme 0 */
  tax: Cents;
  /** Entnahme dieser Position in Netto */
  privatNet: Cents;
  /** Entnahme dieser Position in Steuer */
  privatTax: Cents;
}

/** Summen eines Belegs aus Positionen */
export interface PositionenSummen {
  /** Je Position, in der Reihenfolge der Eingabe */
  zeilen: PositionenZeile[];
  /** Betrieblich je Steuersatz, absteigend nach Satz */
  saetze: TaxShare[];
  net: Cents;
  tax: Cents;
  gross: Cents;
  /** Entnahme: Netto, Steuer und Brutto insgesamt, dazu je Steuersatz */
  privat: { net: Cents; tax: Cents; gross: Cents; saetze: TaxShare[] };
}

const summe = (werte: readonly Cents[]) => werte.reduce((sum, wert) => sum + wert, 0);

/** Ob die Position eine Privatentnahme ist: betrieblich 0, der ganze Betrag gehört zur Entnahme */
function istPrivatentnahme(position: Position): boolean {
  return position.kategorie === PRIVATENTNAHME;
}

/**
 * Teilt Brutto je Steuersatz in Netto und Steuer; die Rechnung weist das Entgelt nach Steuersätzen aufgeschlüsselt aus
 * (§ 14 Abs. 4 Nr. 8 UStG). Beträge desselben Satzes werden zuerst zusammengezählt, dann wird die enthaltene Steuer
 * herausgerechnet und das Netto ist der Rest, genau wie in computeInvoice bei Bruttopreisen. So ergibt Netto plus
 * Steuer wieder centgenau das Brutto.
 */
export function saetzeAusBrutto(betraege: readonly BruttoBetrag[]): TaxShare[] {
  const je = new Map<BasisPoints, Cents>();
  for (const betrag of betraege) je.set(betrag.rate, (je.get(betrag.rate) ?? 0) + betrag.gross);
  return [...je.entries()].sort(([a], [b]) => b - a).map(([rate, gross]) => ({ rate, base: netOf(gross, rate, "brutto"), tax: taxIncluded(gross, rate) }));
}

/** Vorgabe je Satz, ergänzt um Sätze, für die keine Steuer angegeben ist: dann gilt Netto × Satz */
function vorgabeJeSatz(positionen: readonly Position[], saetze: readonly TaxShare[]): DocumentRateAmount[] {
  const vorgabe: DocumentRateAmount[] = saetze.map((satz) => ({ taxRate: satz.rate, net: satz.base, tax: satz.tax }));
  const bekannt = new Set(vorgabe.map((satz) => satz.taxRate));
  for (const rate of new Set(positionen.map((position) => position.rate))) {
    if (bekannt.has(rate)) continue;
    const net = summe(positionen.filter((position) => position.rate === rate).map((position) => position.net));
    vorgabe.push({ taxRate: rate, net, tax: taxOf(net, rate) });
  }
  return vorgabe;
}

/**
 * Verteilt die Steuer je Satz über allocateSplitTax auf die Positionen. Eine Privatentnahme zählt dabei mit ihrem
 * Netto, denn sie steht mit diesem Betrag auf der Rechnung; allocateSplitTax teilt die Steuer des Satzes danach zuerst
 * zwischen Betrieb und Entnahme und weist ihr ihren Anteil zu (#1976).
 */
function verteilung(
  positionen: readonly Position[],
  saetze: readonly TaxShare[],
): {
  steuer: Map<number, Cents>;
  privat: { net: Cents; tax: Cents }[];
} {
  const lines: DocumentSplitLine[] = positionen.map((position) => {
    // allocateSplitTax liest Satz, Netto und die Kategorie; was privat ist, erkennt es an privatentnahme
    return { category: position.kategorie as ExpenseCategory, taxRate: position.rate, net: position.net };
  });
  const verteilt = allocateSplitTax(lines, vorgabeJeSatz(positionen, saetze));
  const steuer = new Map<number, Cents>();
  positionen.forEach((_, index) => {
    steuer.set(index, verteilt[index]!.tax);
  });
  const privat = positionen.map((position, index) => (istPrivatentnahme(position) ? { net: position.net, tax: steuer.get(index) ?? 0 } : { net: 0, tax: 0 }));
  return { steuer, privat };
}

/** Summen je Steuersatz aus einem Feld der Zeilen, absteigend nach Satz; leere Sätze fallen weg */
function jeSatz(zeilen: readonly PositionenZeile[], feld: (zeile: PositionenZeile) => { net: Cents; tax: Cents }): TaxShare[] {
  const je = new Map<BasisPoints, TaxShare>();
  for (const zeile of zeilen) {
    const { net, tax } = feld(zeile);
    const satz = je.get(zeile.rate) ?? { rate: zeile.rate, base: 0, tax: 0 };
    je.set(zeile.rate, { rate: zeile.rate, base: satz.base + net, tax: satz.tax + tax });
  }
  return [...je.values()].filter((satz) => satz.base !== 0 || satz.tax !== 0).sort((a, b) => b.rate - a.rate);
}

/**
 * Summen eines Belegs aus Positionen: betrieblich je Steuersatz und insgesamt, dazu die Entnahme in Netto und
 * Steuer. Maßgeblich ist die Steuer je Satz aus saetze; fehlt ein Satz dort, gilt Netto × Satz. Eine Position
 * privatentnahme zählt nicht zum Betrieb, sondern ganz zur Entnahme. Betrieblich plus Entnahme ergibt wieder die
 * Positionen, die in der Rechnung stehen, denn die Verteilung nimmt keinen Cent weg.
 */
export function positionenSummen(positionen: readonly Position[], saetze: readonly TaxShare[]): PositionenSummen {
  const { steuer, privat } = verteilung(positionen, saetze);
  const zeilen: PositionenZeile[] = positionen.map((position, index) => {
    const anteil = privat[index]!;
    const betrieblich = istPrivatentnahme(position) ? { net: 0, tax: 0 } : { net: position.net, tax: steuer.get(index) ?? 0 };
    return {
      index,
      kategorie: position.kategorie,
      rate: position.rate,
      net: betrieblich.net,
      tax: betrieblich.tax,
      privatNet: anteil.net,
      privatTax: anteil.tax,
    };
  });
  const betrieblich = jeSatz(zeilen, (zeile) => ({ net: zeile.net, tax: zeile.tax }));
  const entnahme = jeSatz(zeilen, (zeile) => ({ net: zeile.privatNet, tax: zeile.privatTax }));
  const net = summe(zeilen.map((zeile) => zeile.net));
  const tax = summe(zeilen.map((zeile) => zeile.tax));
  const privatNet = summe(zeilen.map((zeile) => zeile.privatNet));
  const privatTax = summe(zeilen.map((zeile) => zeile.privatTax));
  return {
    zeilen,
    saetze: betrieblich,
    net,
    tax,
    gross: net + tax,
    privat: { net: privatNet, tax: privatTax, gross: privatNet + privatTax, saetze: entnahme },
  };
}

/**
 * Summenprobe gegen die Vorgabe je Satz: betrieblich plus Entnahme muss je Steuersatz Netto und Steuer der Rechnung
 * ergeben, und keinen Satz darf nur eine der beiden Seiten kennen. Leere Liste = der Beleg geht centgenau auf.
 */
export function summenProbe(summen: PositionenSummen, vorgabe: readonly TaxShare[]): string[] {
  const issues: string[] = [];
  // Ein Satz zweimal in der Vorgabe: allocateSplitTax ueberschreibt je Betrag die Zuteilung, die Probe faende mit find
  // nur den ersten Eintrag. Doppelt genannte Saetze werden deshalb abgewiesen statt geprueft (#1976).
  const doppelt = new Set<BasisPoints>();
  const gesehen = new Set<BasisPoints>();
  for (const satz of vorgabe) {
    if (gesehen.has(satz.rate)) {
      doppelt.add(satz.rate);
      issues.push(`Summenprobe ${satz.rate / 100} %: der Satz steht zweimal in der Vorgabe`);
    }
    gesehen.add(satz.rate);
  }
  const saetze = [
    ...new Set([
      ...vorgabe.map((satz) => satz.rate),
      ...summen.saetze.map((satz) => satz.rate),
      ...summen.privat.saetze.map((satz) => satz.rate),
      ...summen.zeilen.map((zeile) => zeile.rate),
    ]),
  ].sort((a, b) => b - a);
  for (const rate of saetze) {
    if (doppelt.has(rate)) continue;
    const betrieblich = summen.saetze.find((zeile) => zeile.rate === rate);
    const privat = summen.privat.saetze.find((zeile) => zeile.rate === rate);
    const net = (betrieblich?.base ?? 0) + (privat?.base ?? 0);
    const tax = (betrieblich?.tax ?? 0) + (privat?.tax ?? 0);
    // Wie splitIssues: Plus und Minus im selben Satz heben sich zu 0 auf und gingen sonst als aufgeteilt durch (#1976)
    const werte = summen.zeilen.filter((zeile) => zeile.rate === rate).flatMap((zeile) => [zeile.net, zeile.privatNet]);
    if (werte.some((wert) => wert > 0) && werte.some((wert) => wert < 0)) {
      issues.push(`Summenprobe ${rate / 100} %: Netto mit Plus und Minus gemischt; eine Gutschrift hat nur negative Beträge`);
    }
    const satz = vorgabe.find((zeile) => zeile.rate === rate);
    if (!satz) {
      // Ein Satz, den nur die Zeilen kennen und der sich zu 0 aufhebt, steht oben schon als gemischt; eine zweite
      // Meldung über 0,00 € verwirrt nur (#1976)
      if (net !== 0 || tax !== 0)
        issues.push(`Summenprobe ${rate / 100} %: Netto ${formatEuro(net)} und Steuer ${formatEuro(tax)} stehen nicht in der Vorgabe`);
      continue;
    }
    if (net !== satz.base) issues.push(`Summenprobe ${rate / 100} %: Netto ${formatEuro(net)}, Vorgabe ${formatEuro(satz.base)}`);
    if (tax !== satz.tax) issues.push(`Summenprobe ${rate / 100} %: Steuer ${formatEuro(tax)}, Vorgabe ${formatEuro(satz.tax)}`);
  }
  return issues;
}

/** Ob die Privatentnahme in dieser Rechtsform zulässig ist; GmbH und UG kennen kein Privat */
export function privatZulaessig(rechtsform: Rechtsform): boolean {
  return !isKapitalgesellschaft(rechtsform);
}

/** Weist die Kategorie privatentnahme bei GmbH und UG ab; leere Liste = zulässig */
export function pruefePrivatpositionen(positionen: readonly Position[], rechtsform: Rechtsform): string[] {
  if (privatZulaessig(rechtsform) || !positionen.some(istPrivatentnahme)) return [];
  return ["Privatentnahmen gibt es nur im Einzelunternehmen; GmbH und UG kennen kein Privat"];
}

/**
 * Teilt eine Position einmalig in den betrieblichen Teil und die Privatentnahme (#1975) über belegAnteile: Der
 * private Teil wird gerundet, der betriebliche ist die Differenz zum Ausgangsnetto; so ergeben beide zusammen centgenau
 * wieder das Netto, und der gerundete Betrag ist der, den die Beschreibung mit dem Prozentsatz nennt.
 * Gespeichert wird kein Prozentsatz und kein Verweis: Wer korrigieren will, löscht die Entnahme, stellt den Betrag
 * der Ausgangsposition richtig und spaltet neu ab. Das Konto bleibt nur am betrieblichen Teil.
 */
export function privatanteilAbspalten(position: Position, prozent: Prozent): { betrieblich: Position; privat: Position } {
  if (istPrivatentnahme(position)) throw new RangeError("Von einer Privatentnahme lässt sich kein Anteil abspalten");
  if (!Number.isInteger(prozent) || prozent <= 0 || prozent >= 100)
    throw new RangeError("Der Privatanteil muss ein ganzer Prozentsatz über 0 und unter 100 sein");
  const { business, private: privat } = belegAnteile(position.net, prozent);
  // Eine Entnahme mit Netto 0 waere keine Entnahme; splitIssues meldete sie erst spaeter als fehlenden Nettobetrag
  if (privat === 0)
    throw new RangeError(`Der Anteil von ${prozent} % ist bei ${formatEuro(position.net)} gerundet 0 Cent; dafür lässt sich keine Entnahme abspalten`);
  return {
    betrieblich: { ...position, net: business },
    privat: {
      kategorie: PRIVATENTNAHME,
      rate: position.rate,
      net: privat,
      beschreibung: `${prozent} % von ${position.beschreibung?.trim() || position.kategorie}`,
    },
  };
}
