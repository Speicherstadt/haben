import { euerErgebnis, type Cents, type EuerLineKey, type EuerResult } from "@haben/core";
import { depreciationForEuer, listAssets, withdrawalsForEuer } from "../buchhaltung/index.ts";
import type { Db, Tx } from "../../db/index.ts";
import { euerAusJournal } from "./euer-journal.ts";

/*
 * EÜR aus dem Journal (#542, #1116, docs/adr/journal-als-quelle.md, Entscheidung 3): die Zeilen aus euerAusJournal,
 * AfA, Privatnutzung und Entnahme von Anlagen aus dem Journal, sobald das Jahr gebucht ist, vorher aus dem
 * Anlagenverzeichnis. Der Verkauf einer Anlage per Rechnung (#2022) steht nicht im Anlagenverzeichnis: Sein Erlös bleibt in
 * Zeile 19 aus dem Journal. Die Monate für die Grafik netto wie computeEuer: Einnahmen und Ausgaben ohne Umsatz- und
 * Vorsteuer, Zahlungen an das Finanzamt, AfA, Privatnutzung und Entnahme; der Erlös eines Verkaufs ist eine Einnahme wie
 * vor #2022, als er noch in Zeile 15 stand.
 */

/** Zeilen aus den Buchungen des Anlagenverzeichnisses */
const ANLAGE: EuerLineKey[] = ["afa", "sonderAfa", "gwg", "sammelposten", "restbuchwert", "anlagenabgang", "privateKfz", "ustEntnahmen"];
const EINNAHMEN_IM_MONAT = new Set<EuerLineKey>(["einnahmenKleinunternehmer", "einnahmenSteuerpflichtig", "einnahmenSteuerfrei", "kursgewinne"]);
const AUSGABEN_IM_MONAT = (key: EuerLineKey) =>
  key.startsWith("ausgabe:") ||
  key.startsWith("pauschale:") ||
  ["personal", "kursverluste", "steuerNebenleistungen", "schuldzinsen", "schuldzinsenAnlage"].includes(key);

export async function euerAusDemJournal(year: number, q: Db | Tx, { ohneManuelle = false } = {}): Promise<EuerResult> {
  const { summe, monate } = await euerAusJournal(year, q, ohneManuelle);
  // Ohne Zeilen, die sich aufheben (Zahlung und Aufhebung): computeEuer verrechnet sie vorher, die Zeile entsteht dort nicht
  const summen = new Map((Object.entries(summe.zeilen) as [EuerLineKey, Cents][]).filter(([, betrag]) => betrag !== 0));
  // Noch nicht gebucht: AfA und Privatnutzung aus dem Anlagenverzeichnis, die schon gebuchten Anlagen nicht doppelt
  const offen = (await listAssets(year, q)).some((a) => a.pending);
  if (offen) {
    for (const key of ANLAGE) summen.delete(key);
    if (summe.anlagenverkauf) summen.set("anlagenabgang", summe.anlagenverkauf);
  }
  const monat = (m: (typeof monate)[number], einnahmen: boolean) =>
    (Object.entries(m.zeilen) as [EuerLineKey, Cents][])
      .filter(([key]) => (einnahmen ? EINNAHMEN_IM_MONAT.has(key) : AUSGABEN_IM_MONAT(key)))
      .reduce((s, [, betrag]) => s + betrag, einnahmen ? (m.anlagenverkauf ?? 0) : 0);
  return euerErgebnis(
    year,
    summen,
    { einnahmen: monate.map((m) => monat(m, true)), ausgaben: monate.map((m) => monat(m, false)) },
    summe.bewirtungNichtAbziehbar,
    summe.gewerbesteuerNichtAbziehbar,
    offen ? await depreciationForEuer(year, q) : undefined,
    offen ? await withdrawalsForEuer(year, q) : undefined,
  );
}
