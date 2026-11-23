import type { EbilanzZiel } from "./ebilanz.ts";
import type { Kontenrahmen } from "./posting.ts";

/*
 * Positionen der E-Bilanz für Zinsen, Renten, Miete, Pacht und Leasing, die die Gewerbesteuer hinzurechnet (koerperschaft.ts;
 * Kennzeichen G im DATEV-Kontenrahmen 2026, SKR03 Art.-Nr. 11174, SKR04 Art.-Nr. 11175), statt der Auffangposition: Die
 * Buchführung trennt sie schon (BMF-Schreiben vom 28.09.2011, BStBl I S. 855, Rz. 16 und 19). Kfz-Leasing gehört zum
 * Leasing beweglicher Wirtschaftsgüter, nicht zum Fuhrpark (label-guidance-de der HGB-Taxonomien 6.9 und 6.10: Fuhrpark
 * „ohne Abschreibungen, Zinsen und Leasingkosten“, Leasing beweglich „Inkl. Aufwendungen für Kfz-Leasing“); Mietleasing
 * ist kein Finanzierungsleasing, daher jeweils „übrige“. Renten und dauernde Lasten haben eine eigene Position
 * (`annuities`), Garagenmiete steht bei Miete und Pacht für unbewegliche Wirtschaftsgüter, Zinsen an verbundene Unternehmen
 * bei den übrigen Zinsaufwendungen (`expenses.assoc` ist ein Davon-Vermerk außerhalb der Rechenregeln). Miete, Pacht und
 * Lizenzen als Fremdleistungen bleiben bei den bezogenen Leistungen wie die Kategorie Fremdleistungen in ebilanz.ts; eine
 * eigene Position für Miete hat die Taxonomie dort nicht. Zinsen und Miete an Gesellschafter (nur Kennzeichen K) stehen auf
 * den Positionen für Gesellschafter von Kapitalgesellschaften, denn „übrige Miete und Pacht“ gilt nur, „soweit nicht an
 * Mitunternehmer oder Gesellschafter zu entrichten“ (label-guidance-de 6.9 und 6.10; zu `PartnersLoans` „Betrifft nur
 * Kapitalgesellschaften“). Miete unbeweglich
 * (4210/6310) und Kfz-Leasing (4570/6560) stehen bei den Kategorien in ebilanz.ts, die übrigen Zinsen beim Darlehen. Ein
 * Konto, das koerperschaft.ts neu hinzurechnet, braucht hier oder in ebilanz.ts eine Position (ebilanz.test.ts).
 * HGB-Taxonomien 6.9 und 6.10 führen die Aufwandsabschreibung auf Agio, Disagio oder Damnum im Rechenwerk unter
 * expenses.amortDiscount. Die getrennten Positionen für AO-Zinsen stehen in ebilanz.ts bei steuerzahlungKonten.
 */

const OC = "is.netIncome.regular.operatingTC.otherCost";
const FIN = "is.netIncome.regular.fin.netInterest.expenses";
const ZINSEN = `${FIN}.regularInterest.other`;
const GESELLSCHAFTERDARLEHEN = `${FIN}.regularInterest.PartnersLoans`;
const FREMDLEISTUNGEN = "is.netIncome.regular.operatingTC.grossTradingProfit.materialServices.services.unknownVAT";

// Kerntaxonomien 6.9/6.10 (de-gaap-ci, label-de): abgeführter Gewinn im Soll, übernommener Verlust im Haben.
const STILLE_BETEILIGUNG = ["is.netIncome.incomeSharing.gain.silentTypical", "is.netIncome.incomeSharing.loss.typPart"] as const;

const POSITIONEN: Record<Kontenrahmen, readonly [konten: string, ...position: EbilanzZiel][]> = {
  SKR03: [
    ["4575 4810 4965", `${OC}.leasingAll.moveable.other`],
    ["4960 4961 4963", `${OC}.leaseMoveable.other`],
    ["4215", `${OC}.leasingAll.immovable.other`],
    ["4211 4220 4550", `${OC}.leaseFix.other`],
    ["4222", `${OC}.leaseFix.shareholders`],
    ["4958", `${OC}.leaseMoveable.shareholders`],
    ["2100 2109 2118 2119 2125 2129", ZINSEN],
    ["2123 2124", `${FIN}.amortDiscount`],
    ["2114", `${GESELLSCHAFTERDARLEHEN}.other`],
    ["2117", `${GESELLSCHAFTERDARLEHEN}.participationOver25pt`],
    ["2127", `${FIN}.annuities`],
    ["2493", ...STILLE_BETEILIGUNG],
    ["3170 3175 3180", FREMDLEISTUNGEN],
  ],
  SKR04: [
    ["6498 6565 6840", `${OC}.leasingAll.moveable.other`],
    ["6835 6836 6838", `${OC}.leaseMoveable.other`],
    ["6316", `${OC}.leasingAll.immovable.other`],
    ["6315 6317 6550", `${OC}.leaseFix.other`],
    ["6313", `${OC}.leaseFix.shareholders`],
    ["6833", `${OC}.leaseMoveable.shareholders`],
    ["7300 7309 7318 7319 7325 7329", ZINSEN],
    ["7323 7324", `${FIN}.amortDiscount`],
    ["7316", `${GESELLSCHAFTERDARLEHEN}.other`],
    ["7317", `${GESELLSCHAFTERDARLEHEN}.participationOver25pt`],
    ["7327", `${FIN}.annuities`],
    ["7399", ...STILLE_BETEILIGUNG],
    ["5970 5975 5980", FREMDLEISTUNGEN],
  ],
};

/** Konto mit der Position im Soll und gegebenenfalls einer abweichenden Position im Haben */
export function hinzurechnungPositionen(kontenrahmen: Kontenrahmen): [konto: string, position: EbilanzZiel][] {
  return POSITIONEN[kontenrahmen].flatMap(([konten, ...position]) => konten.split(" ").map((konto): [string, EbilanzZiel] => [konto, position]));
}
