import { and, eq, inArray } from "drizzle-orm";
import { hatPrivatanteil, PRIVATENTNAHME, type Prozent } from "@haben/core";
import { db, schema, type Db, type Tx } from "../../db/index.ts";

/*
 * Erhaltenes Skonto auf einen Beleg (#1975): Die Überweisungsliste bietet es an, `skontoErhalten` bucht es aus. Prüften
 * beide Stellen eigene Bedingungen, wich eine davon ab — ein Beleg mit Entnahmezeile wurde gekürzt überwiesen, die
 * Ausbuchung danach abgelehnt, und der Beleg blieb teilweise offen. Beide fragen deshalb diese eine Funktion.
 */

/** Was einer Ausbuchung als erhaltenes Skonto im Weg steht; `grund` ist der Text für die Meldung */
export interface SkontoMoeglichkeit {
  moeglich: boolean;
  grund: string | null;
}

export interface SkontoLage {
  /** § 13b oder innergemeinschaftlicher Erwerb am Beleg */
  reverseCharge: string | null;
  /** Privatanteil am ganzen Beleg in Prozent */
  privateShare: Prozent;
  /** Der Beleg trägt in seiner Aufteilung eine Zeile `privatentnahme` */
  entnahmezeile: boolean;
  /** Kategorie des Belegs; beim Anlagegut mindert Skonto die Anschaffungskosten */
  category: string | null;
}

/**
 * Ob Haben auf dem Beleg erhaltenes Skonto bucht. Ein Privatanteil am Beleg oder eine Entnahmezeile schließt es aus:
 * Die Vorsteuer des Belegs mindert sich nur betrieblich, und der private Teil ist keine Betriebsausgabe. § 13b und das
 * Anlagegut haben ihre eigene Rechnung dafür (write-offs.ts).
 */
export function skontoMoeglich(lage: SkontoLage): SkontoMoeglichkeit {
  if (lage.reverseCharge) {
    return { moeglich: false, grund: "Skonto auf Belege mit § 13b oder innergemeinschaftlichem Erwerb wird nicht unterstützt." };
  }
  if (hatPrivatanteil(lage.privateShare) || lage.entnahmezeile) {
    return { moeglich: false, grund: "Skonto auf Belege mit Privatanteil wird nicht unterstützt." };
  }
  if (lage.category === "anlage") {
    return { moeglich: false, grund: "Skonto auf Anlagegüter mindert die Anschaffungskosten und wird nicht unterstützt." };
  }
  return { moeglich: true, grund: null };
}

/** Kennungen der Belege, deren Aufteilung eine Zeile `privatentnahme` trägt (#1975) */
export async function documentsMitEntnahme(ids: string[], q: Db | Tx = db): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await q
    .select({ documentId: schema.documentSplits.documentId })
    .from(schema.documentSplits)
    .where(and(inArray(schema.documentSplits.documentId, ids), eq(schema.documentSplits.category, PRIVATENTNAHME)));
  return new Set(rows.map((row) => row.documentId));
}

/** Ob dieser eine Beleg eine Entnahmezeile trägt */
export async function hatEntnahmezeile(documentId: string, q: Db | Tx = db): Promise<boolean> {
  return (await documentsMitEntnahme([documentId], q)).has(documentId);
}
