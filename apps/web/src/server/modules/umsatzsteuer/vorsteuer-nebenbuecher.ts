import type { Anteilszeile } from "@haben/core";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema, type Db, type Tx } from "../../db/index.ts";
import { entnahmeZeilen } from "./entnahme-zeilen.ts";
import type { Betrag, Skonto, Zahlung } from "./vorsteuer-leistungsdatum.ts";

/*
 * Die Nebenbücher eines Belegs für die Vorsteuer nach Leistungsdatum (#693): Beträge je Satz, Storno, Zahlungen,
 * Barzahlung, Skonto und die Zeilen privatentnahme (#1975). Ausgelagert aus vorsteuer-leistungsdatum.ts, weil die
 * Datei sonst über die Grenze wächst (checks file-size); die Typen Zahlung, Betrag und Skonto bleiben dort, hier
 * braucht sie nur der Loader.
 */

/** Zuordnung oder Verrechnung auf einen Beleg, mit dem Tag, an dem sie wirkt */
export interface Ausgleich {
  documentId: string | null;
  reversesId: string | null;
  amount: number;
  date: string;
}

/** Was die Nebenbücher zu den Belegen wissen: Beträge je Satz, Storno, Zahlungen, Barzahlung und Skonto */
export interface Nebenbuecher {
  betraege: Betrag[];
  stornoAm: Map<string, string>;
  zahlungen: Map<string, Zahlung[]>;
  /** Zahlungen ohne ihre Aufhebungen: bei einem stornierten Beleg der Stand vor dem Storno */
  zahlungenVorStorno: Map<string, Zahlung[]>;
  barAm: Map<string, string>;
  skontos: Skonto[];
  /** Zeilen privatentnahme je Beleg (#1975); ohne sie gilt der Privatanteil in Prozent */
  entnahme: Map<string, Anteilszeile[]>;
}

/**
 * Zahlungen je Beleg, nur die auf diesen Beleg (Ausgang, negativ), verteilt wird nach Betrag. Eine aufgehobene Zuordnung
 * bleibt am Tag der Zahlung stehen, ihre Gegenzeile nimmt den Anteil am Tag der Aufhebung zurück (allocations.date, #782),
 * damit ein gemeldeter Zeitraum unverändert bleibt. Bei einem stornierten Beleg hat der Storno die Zuordnungen aufgehoben;
 * dort zählt der Stand vor dem Storno, die Rücknahme übernimmt die Stornozeile.
 */
function zahlungenJeBeleg(ausgleiche: Ausgleich[]): Pick<Nebenbuecher, "zahlungen" | "zahlungenVorStorno"> {
  const zahlungen = new Map<string, Zahlung[]>();
  const zahlungenVorStorno = new Map<string, Zahlung[]>();
  const eintragen = (map: Map<string, Zahlung[]>, z: Ausgleich) => {
    // Zahlung: negativer Betrag; Gegenzeile einer Aufhebung: positiver Betrag mit reverses_id
    if (!z.documentId || (z.reversesId ? z.amount <= 0 : z.amount >= 0)) return;
    map.set(z.documentId, [...(map.get(z.documentId) ?? []), { date: z.date, amount: -z.amount }]);
  };
  for (const z of ausgleiche) {
    eintragen(zahlungen, z);
    if (!z.reversesId) eintragen(zahlungenVorStorno, z);
  }
  return { zahlungen, zahlungenVorStorno };
}

/** Lädt die Nebenbücher zu diesen Belegen */
export async function nebenbuecherLaden(q: Db | Tx, ids: string[]): Promise<Nebenbuecher> {
  const a = schema.allocations;
  const t = schema.bankTransactions;
  const s = schema.documentSettlements;
  const c = schema.cashEntries;
  const w = schema.writeOffs;
  const [betraege, stornos, zuordnungen, verrechnungen, baren, skontos, entnahmeZeilenMap] = await Promise.all([
    q
      .select({
        documentId: schema.documentAmounts.documentId,
        rate: schema.documentAmounts.taxRate,
        net: schema.documentAmounts.net,
        tax: schema.documentAmounts.tax,
        vorsteuerAnteil: schema.documentAmounts.vorsteuerAnteil,
      })
      .from(schema.documentAmounts)
      .where(inArray(schema.documentAmounts.documentId, ids)),
    q
      .select({ documentId: schema.documentCancellations.documentId, date: schema.documentCancellations.date })
      .from(schema.documentCancellations)
      .where(inArray(schema.documentCancellations.documentId, ids)),
    q
      .select({ id: a.id, documentId: a.documentId, reversesId: a.reversesId, amount: a.amount, wirktAm: a.date, bookingDate: t.bookingDate })
      .from(a)
      .innerJoin(t, eq(t.id, a.transactionId))
      .where(inArray(a.documentId, ids)),
    q.select({ id: s.id, documentId: s.documentId, reversesId: s.reversesId, amount: s.amount, date: s.date }).from(s).where(inArray(s.documentId, ids)),
    q
      .select({ documentId: c.documentId, date: c.date })
      .from(c)
      .where(and(inArray(c.documentId, ids), isNull(c.reversesId))),
    q
      .select({ id: w.id, documentId: w.documentId, reversesId: w.reversesId, amount: w.amount, date: w.date })
      .from(w)
      .where(and(inArray(w.documentId, ids), eq(w.kind, "skontoErhalten"))),
    entnahmeZeilen(ids, q),
  ]);
  const zuordnungsTage = zuordnungen.map(({ wirktAm, bookingDate, ...z }) => ({ ...z, date: wirktAm ?? bookingDate }));
  return {
    betraege,
    stornoAm: new Map(stornos.map((x) => [x.documentId, x.date])),
    ...zahlungenJeBeleg([...zuordnungsTage, ...verrechnungen]),
    barAm: new Map(baren.flatMap((x) => (x.documentId ? [[x.documentId, x.date] as const] : []))),
    skontos,
    entnahme: entnahmeZeilenMap,
  };
}
