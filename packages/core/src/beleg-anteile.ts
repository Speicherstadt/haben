import { roundHalfAwayFromZero, splitPrivateShare, type BasisPoints, type Cents, type Prozent } from "./money.ts";
import { PRIVATENTNAHME } from "./kontenplan.ts";
import type { TaxShare } from "./steueranteile.ts";

/*
 * Die Anteile eines Belegs an einer Stelle (#1975).
 *
 * Ob ein Betrag eines Belegs betrieblich ist oder zur Entnahme gehört, kam bisher an vielen Stellen aus derselben
 * Prozentrechnung auf `documents.private_share`, je Stelle als eigene Fassung: `splitPrivateShare(x, p).business`,
 * `geschaeftlich()` in vorsteuer-anteile.ts, `business()` in vorsteuer-belege.ts, `privatJeErwerbssatz()` in
 * alte-belegbuchung.ts. Hier steht die Rechnung einmal. Wer den Anteil eines Betrags am Beleg braucht, nimmt diese
 * Funktionen statt selbst zu rechnen.
 *
 * Gerundet wird der private Teil, der betriebliche ist die Differenz (splitPrivateShare in money.ts): Beide zusammen
 * ergeben centgenau den Ausgangsbetrag, und der gerundete Betrag ist der, dessen Prozentsatz in der Beschreibung steht.
 * Ein Privatanteil ist eine Entnahme (§ 4 Abs. 1 Satz 2, § 12 Nr. 1 EStG), keine Betriebsausgabe, und trägt keine
 * abziehbare Vorsteuer: § 15 Abs. 1 Satz 1 Nr. 1 UStG verlangt die betriebliche Verwendung.
 */

/** Betrieblicher und privater Teil eines Betrags am Beleg, wie beim Buchen gerundet */
export function belegAnteile(betrag: Cents, privateShare: Prozent): { business: Cents; private: Cents } {
  return splitPrivateShare(betrag, privateShare);
}

/** Der betriebliche Teil: Aufwand und, soweit abziehbar, Vorsteuer */
export function betrieblicherAnteil(betrag: Cents, privateShare: Prozent): Cents {
  return privateShare === 0 ? betrag : splitPrivateShare(betrag, privateShare).business;
}

/** Der private Teil: Entnahme, brutto auf das Entnahmekonto, ohne Vorsteuer */
export function privaterAnteil(betrag: Cents, privateShare: Prozent): Cents {
  return privateShare === 0 ? 0 : splitPrivateShare(betrag, privateShare).private;
}

/**
 * Ob der Beleg überhaupt einen privaten Anteil trägt; die Sperren (Skonto) fragen so daneben. Die Spalte ist auf 0 bis
 * 100 begrenzt (`documents_private_share_range`), deshalb ist das dasselbe wie `> 0`; eine Entnahmezeile zählt auch,
 * wenn kein Prozentwert am Beleg steht (#1975).
 */
export function hatPrivatanteil(privateShare: Prozent | null | undefined, zeilen: readonly Anteilszeile[] = []): boolean {
  return (privateShare ?? 0) !== 0 || zeilen.some((zeile) => zeile.category === PRIVATENTNAHME);
}

/** Eine Zeile eines Belegs, soweit der Anteil sie braucht */
export interface Anteilszeile {
  category: string;
  taxRate: BasisPoints;
  net: Cents;
  tax: Cents;
}

/**
 * Was ein Beleg an Privatem trägt, aufgelöst nach Steuersatz: der Prozentwert am Beleg (Altbestand) oder die Summe
 * seiner Zeilen `privatentnahme`. Entnahmezeilen haben Vorrang; dann ist `privateShare` 0.
 */
export interface BelegPrivat {
  /** Anteil am ganzen Beleg in Prozent; 0, sobald der Beleg Entnahmezeilen trägt */
  privateShare: Prozent;
  /** Netto und Steuer der Entnahmezeilen je Steuersatz, absteigend nach Satz */
  entnahme: readonly TaxShare[];
}

/** Der Privatanteil eines Belegs aus seinen Zeilen; ohne Entnahmezeilen gilt der Prozentwert am Beleg (#1975) */
export function belegPrivat(privateShare: Prozent | null | undefined, zeilen: readonly Anteilszeile[] = []): BelegPrivat {
  const je = new Map<BasisPoints, { base: Cents; tax: Cents }>();
  for (const zeile of zeilen) {
    if (zeile.category !== PRIVATENTNAHME) continue;
    const satz = je.get(zeile.taxRate) ?? { base: 0, tax: 0 };
    je.set(zeile.taxRate, { base: satz.base + zeile.net, tax: satz.tax + zeile.tax });
  }
  if (je.size === 0) return { privateShare: privateShare ?? 0, entnahme: [] };
  return {
    privateShare: 0,
    entnahme: [...je.entries()].sort(([a], [b]) => b - a).map(([rate, satz]) => ({ rate, ...satz })),
  };
}

/** Ob der Beleg Entnahmezeilen trägt; dann gilt der Prozentwert am Beleg nicht mehr */
export function hatEntnahme(privat: BelegPrivat): boolean {
  return privat.entnahme.length > 0;
}

/**
 * Der betriebliche Teil eines Nettobetrags dieses Steuersatzes. Mit Entnahmezeilen ist es die Differenz zu ihrem Netto,
 * sonst der gerundete Anteil nach dem Prozentwert am Beleg. `gesamt` ist der volle Betrag des Satzes am Beleg; nur bei
 * einer Teilzahlung kleiner als `betrag` und dann trägt die Entnahme ihren Anteil daran.
 */
export function betrieblichNetto(privat: BelegPrivat, rate: BasisPoints, betrag: Cents, gesamt: Cents = betrag): Cents {
  const entnahme = privat.entnahme.find((satz) => satz.rate === rate)?.base ?? 0;
  if (!hatEntnahme(privat)) return betrieblicherAnteil(betrag, privat.privateShare);
  return betrag - anteilAn(entnahme, betrag, gesamt);
}

/** Der betriebliche, also abziehbare Teil der Steuer dieses Steuersatzes; wie betrieblichNetto */
export function betrieblichSteuer(privat: BelegPrivat, rate: BasisPoints, betrag: Cents, gesamt: Cents = betrag): Cents {
  const entnahme = privat.entnahme.find((satz) => satz.rate === rate)?.tax ?? 0;
  if (!hatEntnahme(privat)) return betrieblicherAnteil(betrag, privat.privateShare);
  return betrag - anteilAn(entnahme, betrag, gesamt);
}

/** Der Teil eines Betrags, der auf die Entnahme entfällt: voll bei ganzem Betrag, sonst anteilig gerundet */
function anteilAn(entnahme: Cents, betrag: Cents, gesamt: Cents): Cents {
  if (gesamt === 0) return 0;
  if (betrag === gesamt) return entnahme;
  return roundHalfAwayFromZero((betrag * entnahme) / gesamt);
}
