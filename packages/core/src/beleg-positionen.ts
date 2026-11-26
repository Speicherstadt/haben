import { allocateSplitTax, type DocumentRateAmount, type DocumentSplitLine } from "./document-split.ts";
import { formatEuro, splitPrivateShare, taxIncluded, taxOf, type BasisPoints, type Cents, type Prozent } from "./money.ts";
import type { ExpenseCategory } from "./posting.ts";
import { netOf } from "./rabatt.ts";
import { isKapitalgesellschaft, type Rechtsform } from "./rechtsform.ts";
import type { TaxShare } from "./steueranteile.ts";

/*
 * Beleg aus Positionen statt Beträgen je Steuersatz (#1975). Maßgeblich ist die Steuer je Satz laut Rechnung
 * (§ 14 Abs. 4 Nr. 8 UStG): Sie wird zuerst festgelegt, korrigierbar auf den Wert der Rechnung, und dann über
 * allocateSplitTax nach Netto auf die Positionen des Satzes verteilt. Netto × Satz je Position zu runden liefe
 * gegen die Steuer der Rechnung auseinander und damit gegen Kz 66.
 *
 * Eine Position „Privat“ ist betrieblich genau 0, in Netto und Steuer. Sie entsteht entweder aus einem Prozentsatz
 * ihrer Ausgangsposition, dann bekommt sie den Anteil an deren Netto und deren zugeteilter Steuer, oder als eigener
 * fester Betrag (#1926).
 *
 * Brutto-Eingabe wird je Satz zusammengezählt und wie in computeInvoice in Netto und Steuer geteilt (§ 35 Abs. 1
 * UStDV), erst danach auf die Positionen verteilt.
 *
 * Abziehbar ist nur der betriebliche Teil (§ 15 Abs. 1 Satz 1 Nr. 1 UStG), bei gemischter Nutzung wird er aufgeteilt
 * (§ 15 Abs. 4 UStG); der private Teil ist eine Entnahme (§ 4 Abs. 1 Satz 2 und § 12 Nr. 1 EStG).
 *
 * Alles in Cent, ohne Gleitkomma und ohne Seiteneffekte.
 */

/** Basis eines festen Privatbetrags: netto = der Betrag ist netto, brutto = er enthält die Steuer des Satzes */
export type PrivateAmountBasis = "netto" | "brutto";

/** Normal heißt betrieblich, privat heißt vollständig Entnahme */
export type PositionArt = "normal" | "privat";

/**
 * Eine Position eines Belegs als Wert: Kategorie, Steuersatz, Netto und Art. Kategorie, Beschreibung und eigenes
 * Konto werden nur mitgeführt; die Rechnung liest davon nichts, damit sie ohne Datenmodell und ohne Tabelle
 * funktioniert (#1975). Die Steuer trägt die Position nicht selbst, sie kommt aus der Steuer ihres Satzes.
 */
export interface Position {
  kategorie: string;
  rate: BasisPoints;
  net: Cents;
  art: PositionArt;
  /** Privatposition aus Prozent: Index ihrer normalen Ausgangsposition */
  privatVon?: number;
  /** Privatanteil in Prozent (100 = alles privat), nur mit privatVon */
  prozent?: Prozent;
  /** Fester Privatbetrag in Cent als eigene Position (#1926) */
  privateAmount?: Cents;
  /** Basis von privateAmount; fehlt sie, gilt netto */
  privateAmountBasis?: PrivateAmountBasis;
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
  art: PositionArt;
  /** Betriebliches Netto, bei einer Privatposition 0 */
  net: Cents;
  /** Betriebliche, aus dem Satz zugeteilte Steuer, bei einer Privatposition 0 */
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

/** Eine aus Prozent abgeleitete Privatposition; ihre Werte stehen in ihrer Ausgangsposition, nicht in ihr selbst */
function abgeleitet(position: Position): boolean {
  return position.art === "privat" && position.privatVon !== undefined;
}

/**
 * Teilt Brutto je Steuersatz in Netto und Steuer (§ 35 Abs. 1 UStDV). Beträge desselben Satzes werden zuerst
 * zusammengezählt, dann wird die enthaltene Steuer herausgerechnet und das Netto ist der Rest, genau wie in
 * computeInvoice bei Bruttopreisen. So ergibt Netto plus Steuer wieder centgenau das Brutto.
 */
export function saetzeAusBrutto(betraege: readonly BruttoBetrag[]): TaxShare[] {
  const je = new Map<BasisPoints, Cents>();
  for (const betrag of betraege) je.set(betrag.rate, (je.get(betrag.rate) ?? 0) + betrag.gross);
  return [...je.entries()].sort(([a], [b]) => b - a).map(([rate, gross]) => ({ rate, base: netOf(gross, rate, "brutto"), tax: taxIncluded(gross, rate) }));
}

/**
 * Setzt die Steuer eines Satzes auf den Betrag der Rechnung (§ 14 Abs. 4 Nr. 8 UStG). Plausibel bleibt sie nur mit
 * demselben Vorzeichen wie der Satz (Storno bleibt negativ) und höchstens in Höhe seines Bruttobetrags; sonst null.
 */
export function steuerKorrektur(satz: TaxShare, steuer: Cents): TaxShare | null {
  if (!Number.isSafeInteger(steuer)) return null;
  const brutto = satz.base + satz.tax;
  if (steuer !== 0 && Math.sign(steuer) !== Math.sign(brutto)) return null;
  if (Math.abs(steuer) > Math.abs(brutto)) return null;
  return { ...satz, tax: steuer };
}

/** Vorgabe je Satz, ergänzt um Sätze, für die keine Steuer angegeben ist: dann gilt Netto × Satz */
function vorgabeJeSatz(positionen: readonly Position[], saetze: readonly TaxShare[]): DocumentRateAmount[] {
  const echte = positionen.filter((position) => !abgeleitet(position));
  const vorgabe: DocumentRateAmount[] = saetze.map((satz) => ({ taxRate: satz.rate, net: satz.base, tax: satz.tax }));
  const bekannt = new Set(vorgabe.map((satz) => satz.taxRate));
  for (const rate of new Set(echte.map((position) => position.rate))) {
    if (bekannt.has(rate)) continue;
    const net = summe(echte.filter((position) => position.rate === rate).map((position) => position.net));
    vorgabe.push({ taxRate: rate, net, tax: taxOf(net, rate) });
  }
  return vorgabe;
}

/** Privater Anteil jeder Position in Netto und Steuer; für normale Positionen 0 */
function privatAnteile(positionen: readonly Position[], steuer: ReadonlyMap<number, Cents>): { net: Cents; tax: Cents }[] {
  return positionen.map((position, index) => {
    if (position.art !== "privat") return { net: 0, tax: 0 };
    if (!abgeleitet(position)) return { net: position.net, tax: steuer.get(index) ?? 0 };
    const ausgangsIndex = position.privatVon!;
    const ausgang = positionen[ausgangsIndex];
    if (ausgang?.art !== "normal") throw new RangeError(`Position ${index} verweist als Privatposition auf keine normale Ausgangsposition`);
    const prozent = position.prozent ?? 0;
    return {
      net: splitPrivateShare(ausgang.net, prozent).private,
      tax: splitPrivateShare(steuer.get(ausgangsIndex) ?? 0, prozent).private,
    };
  });
}

/**
 * Verteilt die Steuer je Satz über allocateSplitTax auf die Positionen, die in der Rechnung stehen (normale und
 * feste Privatpositionen). Eine aus Prozent abgeleitete Privatposition zählt nicht mit, ihr Betrag steckt schon in
 * ihrer Ausgangsposition. Danach bekommt jede Privatposition ihren Anteil: aus Prozent vom Netto und von der
 * zugeteilten Steuer der Ausgangsposition, als fester Betrag ihr ganzer Betrag.
 */
function verteilung(
  positionen: readonly Position[],
  saetze: readonly TaxShare[],
): {
  steuer: Map<number, Cents>;
  privat: { net: Cents; tax: Cents }[];
} {
  const echte = positionen.flatMap((position, index) => (abgeleitet(position) ? [] : [index]));
  const lines: DocumentSplitLine[] = echte.map((index) => {
    const position = positionen[index]!;
    // allocateSplitTax liest nur Satz und Netto; die Kategorie reicht es unverändert durch
    return { category: position.kategorie as ExpenseCategory, taxRate: position.rate, net: position.net };
  });
  const verteilt = allocateSplitTax(lines, vorgabeJeSatz(positionen, saetze));
  const steuer = new Map<number, Cents>();
  echte.forEach((index, i) => {
    steuer.set(index, verteilt[i]!.tax);
  });
  return { steuer, privat: privatAnteile(positionen, steuer) };
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
 * Steuer. Maßgeblich ist die Steuer je Satz aus saetze; fehlt ein Satz dort, gilt Netto × Satz. Betrieblich plus
 * Entnahme ergibt wieder die Positionen, die in der Rechnung stehen, denn die Verteilung nimmt keinen Cent weg.
 *
 * Eine aus Prozent abgeleitete Privatposition ist ein Ausschnitt ihrer Ausgangsposition: Sie trägt die Entnahme,
 * und dieselbe Entnahme geht beim Netto und bei der zugeteilten Steuer der Ausgangsposition ab. Sonst zählte der
 * Beleg sie doppelt.
 */
export function positionenSummen(positionen: readonly Position[], saetze: readonly TaxShare[]): PositionenSummen {
  const { steuer, privat } = verteilung(positionen, saetze);
  const abzug = positionen.map(() => ({ net: 0, tax: 0 }));
  privat.forEach((anteil, index) => {
    if (!abgeleitet(positionen[index]!)) return;
    const ausgang = positionen[index]!.privatVon!;
    abzug[ausgang] = { net: abzug[ausgang]!.net + anteil.net, tax: abzug[ausgang]!.tax + anteil.tax };
  });
  const zeilen: PositionenZeile[] = positionen.map((position, index) => {
    const anteil = privat[index]!;
    const betrieblich = abgeleitet(position)
      ? { net: 0, tax: 0 }
      : { net: position.net - anteil.net - abzug[index]!.net, tax: (steuer.get(index) ?? 0) - anteil.tax - abzug[index]!.tax };
    return {
      index,
      kategorie: position.kategorie,
      rate: position.rate,
      art: position.art,
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
 * ergeben. Leere Liste = der Beleg geht centgenau auf.
 */
export function summenProbe(summen: PositionenSummen, vorgabe: readonly TaxShare[]): string[] {
  const issues: string[] = [];
  for (const satz of vorgabe) {
    const betrieblich = summen.saetze.find((zeile) => zeile.rate === satz.rate);
    const privat = summen.privat.saetze.find((zeile) => zeile.rate === satz.rate);
    const net = (betrieblich?.base ?? 0) + (privat?.base ?? 0);
    const tax = (betrieblich?.tax ?? 0) + (privat?.tax ?? 0);
    if (net !== satz.base) issues.push(`Summenprobe ${satz.rate / 100} %: Netto ${formatEuro(net)}, Vorgabe ${formatEuro(satz.base)}`);
    if (tax !== satz.tax) issues.push(`Summenprobe ${satz.rate / 100} %: Steuer ${formatEuro(tax)}, Vorgabe ${formatEuro(satz.tax)}`);
  }
  return issues;
}

/** Ob die Position „Privat“ in dieser Rechtsform zulässig ist; GmbH und UG kennen kein Privat */
export function privatZulaessig(rechtsform: Rechtsform): boolean {
  return !isKapitalgesellschaft(rechtsform);
}

/** Weist Privatpositionen bei GmbH und UG ab; leere Liste = zulässig */
export function pruefePrivatpositionen(positionen: readonly Position[], rechtsform: Rechtsform): string[] {
  if (privatZulaessig(rechtsform) || !positionen.some((position) => position.art === "privat")) return [];
  return ["Privatpositionen gibt es nur im Einzelunternehmen; GmbH und UG kennen kein Privat"];
}

/**
 * Legt aus einer normalen Ausgangsposition die Privatposition aus Prozent an. Ihr Netto ist der Anteil am Netto der
 * Ausgangsposition; die Steuer kommt bei jeder Rechnung aus deren zugeteilter Steuer, damit sie nicht veraltet.
 */
export function privatPositionAusProzent(ausgang: Position, prozent: Prozent, index: number): Position {
  if (ausgang.art !== "normal") throw new RangeError("Eine Privatposition entsteht nur aus einer normalen Position");
  if (!Number.isInteger(prozent) || prozent < 0 || prozent > 100) throw new RangeError("Der Privatanteil muss ein ganzer Prozentsatz zwischen 0 und 100 sein");
  if (!Number.isInteger(index) || index < 0) throw new RangeError("Die Ausgangsposition braucht ihren Index in der Liste");
  return {
    kategorie: ausgang.kategorie,
    rate: ausgang.rate,
    net: splitPrivateShare(ausgang.net, prozent).private,
    art: "privat",
    privatVon: index,
    prozent,
    ...(ausgang.beschreibung === undefined ? {} : { beschreibung: `${prozent} % von ${ausgang.beschreibung}` }),
  };
}

/**
 * Position „Privat“ mit festem Betrag ohne Ausgangsposition (#1926): Netflix vollständig privat auf derselben
 * Rechnung wie das anteilig genutzte Internet. Bei Basis brutto wird die Steuer herausgerechnet, das Netto ist der
 * Rest; die Steuer der Position kommt bei der Rechnung aus ihrem Satz.
 */
export function privatPositionFesterBetrag(betrag: Cents, basis: PrivateAmountBasis, satz: BasisPoints, kategorie = "privat"): Position {
  return {
    kategorie,
    rate: satz,
    net: basis === "brutto" ? netOf(betrag, satz, "brutto") : betrag,
    art: "privat",
    privateAmount: betrag,
    privateAmountBasis: basis,
  };
}
