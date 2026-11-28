import { ACCOUNTS, ASSET_ACCOUNTS, PRIVATE_USE_ACCOUNTS, type Cents, type Kontenrahmen } from "@haben/core";
import { depreciationForEuer, withdrawalsForEuer } from "../buchhaltung/index.ts";
import type { Db, Tx } from "../../db/index.ts";

/** Saldo Soll − Haben der Buchungen des Anlagenverzeichnisses auf den Konten, je im Kontenrahmen der Buchung */
export type AnlagenSaldo = (accounts: (kr: Kontenrahmen) => string[]) => Cents;

/**
 * EÜR-Abgleich der Buchungen des Anlagenverzeichnisses gegen das Verzeichnis (abgleich.ts, euerAbgleich): AfA, GWG,
 * Sammelposten, Restbuchwert, Entnahme von Anlagen (#1970), Privatnutzung und die Umsatzsteuer darauf. Erst, wenn das
 * Jahr gebucht ist.
 */
export async function anlagenZeilen(year: number, saldo: AnlagenSaldo, q: Db | Tx): Promise<{ posten: string; journal: Cents; quelle: Cents }[]> {
  const afa = await depreciationForEuer(year, q);
  const privat = await withdrawalsForEuer(year, q);
  return [
    { posten: "AfA", journal: saldo((kr) => [ASSET_ACCOUNTS[kr].afa, ASSET_ACCOUNTS[kr].afaKfz]), quelle: afa.afa },
    { posten: "Sofortabschreibung GWG", journal: saldo((kr) => [ASSET_ACCOUNTS[kr].afaGwg]), quelle: afa.gwg },
    { posten: "Auflösung Sammelposten", journal: saldo((kr) => [ASSET_ACCOUNTS[kr].afaSammelposten]), quelle: afa.sammelposten },
    {
      posten: "Restbuchwert ausgeschiedener Anlagen",
      journal: saldo((kr) => [ASSET_ACCOUNTS[kr].restbuchwert, ASSET_ACCOUNTS[kr].restbuchwertGewinn]),
      quelle: afa.restbuchwert,
    },
    { posten: "Entnahme von Anlagen", journal: -saldo((kr) => Object.values(ASSET_ACCOUNTS[kr].entnahme)), quelle: privat.anlagenabgang },
    { posten: "Private Kfz-Nutzung", journal: -saldo((kr) => Object.values(PRIVATE_USE_ACCOUNTS[kr])), quelle: privat.privateKfz },
    {
      // Ohne Entnahme der bisherige Text: Beim Update übernommene Befunde ohne Schlüssel erkennt der Abgleich am Text wieder
      posten: privat.anlagenabgang === 0 ? "Umsatzsteuer auf die private Kfz-Nutzung" : "Umsatzsteuer auf Privatnutzung und Entnahme von Anlagen",
      journal: -saldo((kr) => [ACCOUNTS[kr].ust[1900]]),
      quelle: privat.ustEntnahmen,
    },
  ];
}
