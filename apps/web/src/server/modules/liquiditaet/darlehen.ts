import { darlehensPosten, type LiquiditaetsPosten } from "@haben/core";
import { darlehenZahlungen } from "../bank/index.ts";
import type { Kontext } from "./kontext.ts";

/*
 * Darlehensraten (#1381): Haben kennt am Darlehen keine Rate; der Kern schreibt die im Bankabgleich zugeordneten Tilgungen
 * und Zinsen fort (liquiditaet-darlehen.ts). Ein Darlehen mit Bestand, aber ohne zugeordnete Rate bringt einen Hinweis.
 */
export async function darlehenPosten(k: Kontext): Promise<{ posten: LiquiditaetsPosten[]; hinweise: string[] }> {
  const ergebnisse = (await darlehenZahlungen()).map((darlehen) =>
    darlehensPosten({ darlehen, heute: k.heute, bis: k.bis, bundesland: k.bundesland, bankdatenAb: k.bankdatenAb }),
  );
  return { posten: ergebnisse.flatMap((e) => e.posten), hinweise: ergebnisse.flatMap((e) => (e.hinweis ? [e.hinweis] : [])) };
}
