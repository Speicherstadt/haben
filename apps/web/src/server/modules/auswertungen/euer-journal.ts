import { kleinunternehmerForMonth } from "../stammdaten/index.ts";
import { leereEuerAusJournal, type EuerAusJournal, type Kontenrahmen } from "@haben/core";
import { and, asc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { db, schema, type Db, type Tx } from "../../db/index.ts";
import { imEuerJahr } from "./euer-jahreswechsel.ts";
import {
  ausgleichsBuchungenJe,
  bloecke,
  buchungen,
  type EuerBeitraege,
  buchungenJe,
  melden,
  meldenVerrechnung,
  verrechnungenJeRechnung,
} from "./euer-journal-buchungen.ts";
import { belegNebenbuecher } from "./euer-journal-nebenbuch.ts";
import { importAnteile } from "./euer-import.ts";
import { dazu, type EuerLauf, type Verrechnung, wirkung, wirkungVerrechnung, type Ziel } from "./euer-journal-wirkung.ts";

/*
 * EÜR aus dem Journal (#542, Schritt 5b), als Schattenrechnung neben euerForYear. Eine Buchung ohne Forderungen und
 * Verbindlichkeiten (Bank, Kasse, privat bezahlt, Pauschale, AfA) zählt mit ihrem Datum nach ihren Konten. Eine Rechnung
 * bzw. ein Beleg auf Ziel zählt erst mit der Zahlung: Jede Zahlung, Bareinnahme oder Kursdifferenz wird anteilig auf die
 * Zeilen der Buchung verteilt, die sie ausgleicht (zahlungsAnteil). Welche das ist, sagt die Zuordnung im Nebenbuch.
 * Skonto und Forderungsausfall wirken nicht, die EÜR zählt nur, was gezahlt wird.
 */

/** Rechnung bzw. Beleg, den eine Zahlung, Ausbuchung oder Bareinnahme ausgleicht, je Herkunft der Buchung */
async function ziele(q: Db | Tx, ids: string[]): Promise<Map<string, Ziel>> {
  const result = new Map<string, Ziel>();
  if (ids.length === 0) return result;
  const a = schema.allocations;
  const w = schema.writeOffs;
  const c = schema.cashEntries;
  for (const block of bloecke(ids)) {
    for (const r of await q.select({ id: a.id, invoiceId: a.invoiceId, documentId: a.documentId, loanId: a.loanId }).from(a).where(inArray(a.id, block)))
      result.set(r.id, r);
    for (const r of await q.select({ id: w.id, invoiceId: w.invoiceId, documentId: w.documentId }).from(w).where(inArray(w.id, block))) result.set(r.id, r);
    for (const r of await q.select({ id: c.id, invoiceId: c.invoiceId, documentId: c.documentId }).from(c).where(inArray(c.id, block))) result.set(r.id, r);
  }
  return result;
}

/** Verrechnungen des Jahres, älteste zuerst: je Zeile gleicht eine den Beleg aus, eine Gegenzeile hebt sie auf */
async function verrechnungenImJahr(q: Db | Tx, year: number): Promise<Verrechnung[]> {
  const s = schema.documentSettlements;
  return q
    .select({ id: s.id, dokumentId: s.documentId, date: s.date, betrag: s.amount })
    .from(s)
    .where(and(gte(s.date, `${year}-01-01`), lt(s.date, `${year + 1}-01-01`)))
    .orderBy(asc(s.date), asc(s.createdAt), asc(s.id));
}

/** Kontenrahmen der Firma: für einen Beleg ganz ohne Buchung die einzige Angabe zum Rahmen (aus Lexoffice übernommen) */
async function firmenKontenrahmen(q: Db | Tx): Promise<Kontenrahmen> {
  const [firma] = await q.select({ kontenrahmen: schema.company.kontenrahmen }).from(schema.company).limit(1);
  return firma?.kontenrahmen ?? "SKR03";
}

export interface EuerJournal {
  summe: EuerAusJournal;
  /** Importierte Ausgleiche ohne eindeutigen Quellbezug; keine geschätzte EÜR-Zuordnung. */
  ungeklaerteImporte: number;
  /** Wirkung je Monat (Index 0 = Januar), für die Grafik nach Monaten */
  monate: EuerAusJournal[];
}

/** Buchungen des Jahres, ohne Eröffnungen und, wenn verlangt, ohne manuelle Buchungen */
function imZeitraum(year: number, ohneManuelle: boolean) {
  const e = schema.journalEntries;
  return and(
    gte(e.date, `${year}-01-01`),
    lt(e.date, `${year + 1}-01-01`),
    ne(e.sourceType, "eroeffnung"),
    ohneManuelle ? ne(e.sourceType, "manuell") : undefined,
  );
}

/**
 * Die EÜR eines Jahres aus dem Journal: Zeilen wie computeEuer, ohne AfA und Privatnutzung, die noch nicht gebucht sind.
 * `ohneManuelle`: ohne manuelle Buchungen (GmbH und UG, dort Abschlussbuchungen, reports.ts); `beitraege` bekommt die Wirkung je Buchung.
 */
export async function euerAusJournal(year: number, q: Db | Tx = db, ohneManuelle = false, beitraege?: EuerBeitraege): Promise<EuerJournal> {
  const kuMonate = await Promise.all(Array.from({ length: 12 }, (_, i) => kleinunternehmerForMonth(year, i + 1, q)));
  const buchungenImJahr = await buchungen(q, imZeitraum(year, ohneManuelle));
  // Vorauszahlung für Dezember bzw. das vierte Quartal vom 1. bis 10. Januar im Vorjahr (euer-jahreswechsel.ts)
  const jahr = await imEuerJahr(year, buchungenImJahr, q);
  const importiert = await importAnteile(q, jahr);
  const zielVon = await ziele(
    q,
    jahr.filter((b) => b.sourceType === "allocation" || b.sourceType === "ausbuchung" || b.sourceType === "kasse").map((b) => b.sourceId),
  );
  const loanIds = [...new Set([...zielVon.values()].flatMap((z) => (z.loanId ? [z.loanId] : [])))];
  const anlageDarlehen = new Set(
    loanIds.length === 0
      ? []
      : (
          await q
            .select({ id: schema.loans.id })
            .from(schema.loans)
            .where(and(inArray(schema.loans.id, loanIds), eq(schema.loans.purpose, "anlagevermoegen")))
        ).map((r) => r.id),
  );

  // Was die Zahlungen ausgleichen, gesammelt für alle Rechnungen und Belege des Jahres statt je Posten (#542, Schritt 9)
  const rechnungIds = [...new Set([...zielVon.values()].flatMap((z) => (z.invoiceId ? [z.invoiceId] : [])))];
  // Verrechnungen des Jahres (#274): Sie wirken wie Zahlungen auf beide Belege, auch wenn in dem Jahr keine Zahlung sie ausgleicht
  const verrechnet = await verrechnungenImJahr(q, year);
  const einfacheBelege = [...zielVon.values()].flatMap((z) => (!z.invoiceId && z.documentId ? [z.documentId] : []));
  const belegIds = [...new Set([...einfacheBelege, ...verrechnet.map((v) => v.dokumentId)])];
  const gebuchtVon = { invoice: await buchungenJe(q, "invoice", rechnungIds), document: await buchungenJe(q, "document", belegIds) };
  const ausgleicheVon = await ausgleichsBuchungenJe(q, rechnungIds);
  // Verrechnungen des Jahres (#274): Sie nehmen das Entgelt der Gegenrechnung aus dem Steuermix, an ihrer Stelle in der
  // Reihenfolge der Buchungen — sonst teilt die EÜR eine Zahlung über die volle Rechnung (#877, Befund 3)
  const verrechnungenVon = await verrechnungenJeRechnung(q, rechnungIds);
  const nebenbuchVon = await belegNebenbuecher(q, belegIds);
  const anlagen = new Set<string>();
  // Belege der Kategorie Anlage: ausgeglichene und direkt gebuchte (privat oder bar bezahlt)
  const anlageKandidaten = [...new Set([...belegIds, ...jahr.filter((b) => b.sourceType === "document").map((b) => b.sourceId)])];
  for (const block of bloecke(anlageKandidaten))
    for (const r of await q
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(and(inArray(schema.documents.id, block), eq(schema.documents.category, "anlage"))))
      anlagen.add(r.id);
  const lauf: EuerLauf = {
    year,
    q,
    kuMonate,
    importiert,
    zielVon,
    anlageDarlehen,
    gebuchtVon,
    ausgleicheVon,
    verrechnungenVon,
    nebenbuchVon,
    anlagen,
    zaehler: { ungeklaerteImporte: 0 },
    ursprung: new Map(),
  };
  const summe = leereEuerAusJournal();
  const monate = Array.from({ length: 12 }, () => leereEuerAusJournal());
  for (const b of jahr) {
    const beitrag = melden(beitraege, b, zielVon.get(b.sourceId), await wirkung(lauf, b));
    dazu(summe, beitrag);
    dazu(monate[Number(b.date.slice(5, 7)) - 1]!, beitrag);
  }
  // Verrechnungen (#274) wie eine Zahlung im Monat der Aufrechnung; der Rahmen dient nur einem Beleg ganz ohne Buchung
  const belegKontenrahmen = verrechnet.length > 0 ? await firmenKontenrahmen(q) : "SKR03";
  for (const v of verrechnet) {
    const beitrag = meldenVerrechnung(beitraege, v, belegKontenrahmen, await wirkungVerrechnung(lauf, v, belegKontenrahmen));
    dazu(summe, beitrag);
    dazu(monate[Number(v.date.slice(5, 7)) - 1]!, beitrag);
  }
  return { summe, ungeklaerteImporte: lauf.zaehler.ungeklaerteImporte, monate };
}
