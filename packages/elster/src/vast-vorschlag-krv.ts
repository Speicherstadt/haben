import { roundHalfAwayFromZero, type Cents } from "@haben/core";
import { abrunden, alle, aufrunden, betrag, wert, type XmlKnoten } from "./vast-lesen.ts";

/*
 * Kranken- und Pflegeversicherung aus VaSt_KRV (#1328), nach VAST_Vorberechnungen_<Jahr>.ods, Blatt „VaSt_KRV_Gesamt -
 * Regeln“ (gleich für 2022 bis 2025): je Person die Summe der Beträge nach Art, Beiträge aufgerundet, Erstattungen
 * abgerundet, über der Grenze kein Wert. Codes laut Schema: MerkmalBeitragArt 1 gesetzlich, 2 privat; BetragArt 01 Beitrag
 * ohne, 02 mit Anspruch auf Krankengeld, 05 Pflege, 06/07/10 Erstattungen, 15 bis 18 Zuschüsse und ihre Rückforderung;
 * MerkmalBeiTrag 1 Dritte, 2 unbekannt, 3 Versicherungsnehmer.
 */

export interface KrvSumme {
  /** Gesetzlich, ohne Anteil für Krankengeld (E2001805 abzüglich 4 % der Beiträge mit Krankengeld) */
  gkv?: Cents;
  /** Gesetzlich, Anteil für Krankengeld */
  gkvZusatz?: Cents;
  gpv?: Cents;
  pkv?: Cents;
  ppv?: Cents;
  pkvErstattung?: Cents;
}

/** Beitragsdaten eines Belegs, die für die Person zählen (Filter „F(A)“ der Regeln, etwa Berechne_E2001805_Ungeprueft) */
export function krvBeitraege(root: XmlKnoten, idnrPerson: string, idnrPaar: readonly string[]): XmlKnoten[] {
  const versichert = wert(root, "BetroffenerFall", "BetroffenePerson", "NatPerson", "IdNr");
  if (versichert !== idnrPerson) return [];
  const vn = alle(root, "BetroffenerFall", "BetroffenePerson", "WeiterePerson")[0];
  const vnIdnr = wert(vn, "NatPerson", "IdNr");
  const vnFirma = wert(vn, "NNPers", "Firmenname");
  return alle(root, "Vertragsdaten", "Beitragsdaten").filter((d) => {
    const merkmal = wert(d, "MerkmalBeiTrag");
    if (vnIdnr && idnrPaar.includes(vnIdnr)) return merkmal === undefined || merkmal === "2" || merkmal === "3";
    return Boolean(vnFirma) && (merkmal === undefined || ["1", "2", "3"].includes(merkmal));
  });
}

const summe = (daten: readonly XmlKnoten[], merkmalArt: string, arten: readonly string[]): Cents =>
  daten
    .filter((d) => wert(d, "MerkmalBeitragArt") === merkmalArt && arten.includes(wert(d, "BetragArt") ?? ""))
    .reduce((s, d) => s + (betrag(d, "Betrag") ?? 0), 0);

/** Wert nur innerhalb der Grenze der Regel (in Euro); darüber bleibt das Feld leer */
const bis = (c: Cents, grenzeEuro: number): Cents | undefined => (c !== 0 && Math.abs(c) <= grenzeEuro * 100 ? c : undefined);

/**
 * Summen je Person. Abweichend von der Zuordnung (erlaubt laut Entwicklerhandbuch S. 332, Fußnote 68) stehen Beiträge mit
 * Anspruch auf Krankengeld nicht als eigene Zeile (E2002005), sondern wie in Habens Angaben: um 4 % gemindert im Beitrag,
 * die 4 % als Krankengeldanteil (§ 10 Abs. 1 Nr. 3 Buchst. a Satz 4 EStG)
 */
export function krvSumme(daten: readonly XmlKnoten[]): { werte: KrvSumme; ueberGrenze: string[] } {
  const mitKrankengeld = summe(daten, "1", ["02"]);
  const anteil = roundHalfAwayFromZero((mitKrankengeld * 4) / 100);
  const roh: Required<KrvSumme> = {
    gkv: aufrunden(summe(daten, "1", ["01", "02"]) - anteil),
    gkvZusatz: anteil,
    gpv: aufrunden(summe(daten, "1", ["05"])),
    pkv: aufrunden(summe(daten, "2", ["01"])),
    ppv: aufrunden(summe(daten, "2", ["05"])),
    pkvErstattung: abrunden(summe(daten, "2", ["06", "10"])),
  };
  const grenzen: Record<keyof KrvSumme, number> = { gkv: 99_999, gkvZusatz: 99_999, gpv: 9_999, pkv: 99_999, ppv: 9_999, pkvErstattung: 99_999 };
  const werte: KrvSumme = {};
  const ueberGrenze: string[] = [];
  for (const feld of Object.keys(roh) as (keyof KrvSumme)[]) {
    const w = bis(roh[feld], grenzen[feld]);
    if (w !== undefined) werte[feld] = w;
    else if (roh[feld] !== 0) ueberGrenze.push(feld);
  }
  return { werte, ueberGrenze };
}

/** Gibt es Beträge, die Haben noch in kein Feld übernimmt: gesetzliche Erstattungen, Zuschüsse? */
export function krvOhneFeld(daten: readonly XmlKnoten[]): { erstattungGesetzlich: boolean; zuschuss: boolean } {
  return {
    erstattungGesetzlich: summe(daten, "1", ["06", "07", "10"]) !== 0,
    zuschuss: summe(daten, "1", ["15", "16", "17", "18"]) !== 0 || summe(daten, "2", ["15", "16", "17", "18"]) !== 0,
  };
}
