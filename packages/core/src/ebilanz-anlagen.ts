import { ASSET_ACCOUNTS } from "./afa.ts";
import type { EbilanzZiel } from "./ebilanz.ts";
import type { Kontenrahmen } from "./posting.ts";

/*
 * Positionen der E-Bilanz für die Konten des Anlagenverzeichnisses (HGB-Taxonomien 6.9 und 6.10): Anlagen, AfA, Restbuchwert
 * und der Verkauf einer Anlage per Rechnung (#2022). Dessen Erlöskonten „Erlöse aus Verkäufen Sachanlagevermögen“ stehen auf
 * „Erlöse aus Verkäufen von sonstigen Sachanlagen“, bei Buchgewinn unter den Erträgen aus Abgängen des Anlagevermögens, bei
 * Buchverlust unter den Verlusten aus dem Abgang; die Auffangposition nur ohne Trennung in der Buchführung (BMF-Schreiben
 * vom 28.09.2011, BStBl I S. 855, Rz. 19).
 */

const IS = "is.netIncome.regular.operatingTC";
const OC = `${IS}.otherCost`;
const DEPR = `${IS}.deprAmort.fixAss.tan`;
const EQUIPM = "bs.ass.fixAss.tan.otherEquipm";

export function anlagenKonten(kontenrahmen: Kontenrahmen): [string, EbilanzZiel][] {
  const anlagen = ASSET_ACCOUNTS[kontenrahmen];
  return [
    [anlagen.anlage.kfz, [`${EQUIPM}.passengerCars`]],
    [anlagen.anlage.edv, [`${EQUIPM}.office`]],
    [anlagen.anlage.buero, [`${EQUIPM}.office`]],
    [anlagen.anlage.sonstiges, [`${EQUIPM}.otherbga`]],
    [anlagen.anlage.transport, [`${EQUIPM}.otherTransportMeans`]],
    [anlagen.gwg, [`${EQUIPM}.gwg`]],
    [anlagen.sammelposten, [`${EQUIPM}.gwgsammelposten`]],
    [anlagen.afa, [`${DEPR}.other`]],
    [anlagen.afaKfz, [`${DEPR}.other`]],
    [anlagen.afaGwg, [`${DEPR}.lowValueAs`]],
    [anlagen.afaSammelposten, [`${DEPR}.lowValueAsCollItem`]],
    [anlagen.restbuchwert, [`${OC}.disposFixAss.bookValue.tan.other`]],
    ...Object.values(anlagen.verkauf).map((k): [string, EbilanzZiel] => [k, [`${IS}.otherOpRevenue.disposFixAss.sale.tan.other`]]),
    ...Object.values(anlagen.verkaufVerlust).map((k): [string, EbilanzZiel] => [k, [`${OC}.disposFixAss.sale.tan.other`]]),
  ];
}
