import { reservedAccountNumbers, type Kontenrahmen } from "@haben/core";
import { count, eq, sql } from "drizzle-orm";
import { abgleichAll, abweichungen, ohneUebernommeneZeilen, type AbgleichZeile } from "./abgleich.ts";
import { lastFileCheck, type FileCheck } from "./file-integrity.ts";
import { db, schema } from "../../db/index.ts";
import { loadCompany } from "../stammdaten/index.ts";
import { today } from "../../today.ts";
import { checkTriggerIntegrity, checkTriggerInventory, type InventoryChecksum } from "../../db/trigger-inventory.ts";

import { PRUEFUNG_ABGEBROCHEN } from "../../../lib/pruefbericht.ts";

export { formatPruefwert, parsePruefwert } from "../../../lib/pruefwert.ts";

/**
 * Manipulationserkennung (GoBD): Das Audit-Log ist eine Hash-Kette, festgeschriebene Datensätze tragen ein Siegel.
 * Berechnet und geprüft wird beides in der Datenbank (drizzle/0063_hash_kette_trigger.sql). Wer die Datenbank
 * ändern kann, kann auch die Kette neu berechnen; aufgedeckt wird das erst mit einem Prüfwert von außerhalb des
 * Servers (Jahresarchiv, wöchentliche Mail), siehe checkPruefwert.
 */

/** Kopf der Kette: Nummer und Hash des letzten Eintrags */
export interface ChainHead {
  seq: number;
  hash: string;
  /** Zeitpunkt des letzten Eintrags */
  at: Date | null;
}

export interface IntegrityProblem {
  /** kette: Audit-Log; kopf: Kettenkopf; siegel: festgeschriebener Datensatz; sperre: Trigger, Funktion oder Standardwert einer Spalte */
  art: "kette" | "kopf" | "siegel" | "sperre";
  tabelle: string;
  zeile: string | null;
  seq: number | null;
  befund: string;
}

export interface IntegrityReport {
  head: ChainHead | null;
  entries: number;
  seals: number;
  problems: IntegrityProblem[];
  /** true, wenn eine Art von Befund mehr als die angezeigten hat */
  truncated: boolean;
  /**
   * Abgleich im Journal (abgleich.ts): Verprobung der Umsatzsteuer, gesendete Voranmeldungen, Rechnungen, Bank, EÜR und
   * Anzahlungsbestände; Abweichungen und was nicht verglichen werden konnte. Eine Abweichung ist kein Beweis für eine
   * Manipulation, aber ein Widerspruch in den Büchern, der zu klären ist.
   */
  abgleich: { abweichungen: AbgleichZeile[]; hinweise: string[] };
  /** Eigene Nummern, die eine spätere Version von Haben selbst nutzt; kein Beweis einer Manipulation. */
  accountCollisions: { kontenrahmen: Kontenrahmen; account: string; name: string }[];
  /** Zusätzliche Betreibertrigger sind Hinweise, keine Korruptionsbefunde. */
  triggerHints: string[];
  /** Prüfsumme der Sperren: eigener Bestand und ausgelieferter Sollbestand (#1683) */
  inventoryChecksum: InventoryChecksum;
  /** Letzte Vollprüfung der Dateien im Dokumentenspeicher (file-integrity.ts); null, solange keine lief */
  files: FileCheck | null;
}

/** Lesezugriff auf die Datenbank: db selbst oder eine Transaktion */
type Reader = Pick<typeof db, "select" | "execute">;

export async function chainHead(reader: Reader = db): Promise<ChainHead | null> {
  const [head] = await reader
    .select({ seq: schema.auditChain.seq, hash: schema.auditChain.hash, at: schema.auditLog.at })
    .from(schema.auditChain)
    .leftJoin(schema.auditLog, eq(schema.auditLog.seq, schema.auditChain.seq));
  if (!head) return null;
  return { seq: head.seq, hash: head.hash.toString("hex"), at: head.at };
}

const MAX_ROWS = 100;

type IntegrityRow = { art: IntegrityProblem["art"]; tabelle: string; zeile: string | null; seq: string | null; befund: string };

/**
 * Befunde von haben_integrity_problems. Bricht die Funktion ab, etwa weil sich der Standardwert einer Spalte, die ein
 * älteres Siegel nicht abdeckt, nicht auswerten lässt, oder weil sie fehlt, wird das ein Befund (#1604): Ein Savepoint
 * hält die Transaktion für die übrigen Prüfungen offen, und „Kette prüfen“ und die Prüfwert-Mail melden den Abbruch,
 * statt mit einem Fehler zu enden. Über Kette und Siegel sagt der Bericht dann nichts aus.
 */
async function integrityRows(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]): Promise<IntegrityRow[]> {
  try {
    return await tx.transaction((sp) => sp.execute<IntegrityRow>(sql`select art, tabelle, zeile, seq, befund from haben_integrity_problems(${MAX_ROWS})`));
  } catch (error) {
    return [
      {
        art: "sperre",
        tabelle: "haben_integrity_problems",
        zeile: null,
        seq: null,
        befund: `${PRUEFUNG_ABGEBROCHEN}: ${fehlerGrund(error)}`,
      },
    ];
  }
}

/** Meldung eines Fehlers für Befunde; bei einer gescheiterten Abfrage die der Datenbank statt „Failed query: …“ */
export function fehlerGrund(error: unknown): string {
  if (error instanceof Error && error.cause instanceof Error) return error.cause.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Befunde, Kopf, Anzahlen und Abgleich aus einem Stand der Datenbank. Einzeln gelesen verschob ein Eintrag, der
 * dazwischen hinzukam, Anzahl und Kopf gegeneinander, und der Abgleich sah eine Buchung nebenher nur auf einer Seite.
 * REPEATABLE READ hält den Stand über alle Abfragen der Transaktion fest.
 */
function readSnapshot(now: string) {
  return db.transaction(
    async (tx) => {
      // Vor haben_integrity_problems: Den Suchpfad liest die Prüfung so, wie die Prüffunktionen ihn vorfinden. Eine fremde
      // Funktion, die sie aufrufen, könnte ihn bis zum Ende der Transaktion ändern.
      const triggers = await checkTriggerInventory(tx);
      const rows = await integrityRows(tx);
      const head = await chainHead(tx);
      const [entries] = await tx.select({ n: count() }).from(schema.auditLog);
      const [seals] = await tx.select({ n: count() }).from(schema.seals);
      const abgleich = await abgleichAll(now, tx);
      // #787: Auch archivierte Konten und frühere Kontenrahmen bestimmen weiterhin die Bedeutung alter Buchungen.
      // https://github.com/Speicherstadt/haben/issues/787#issuecomment-6840030954
      const ownAccounts = await tx
        .select({ kontenrahmen: schema.ownAccounts.kontenrahmen, account: schema.ownAccounts.account, name: schema.ownAccounts.name })
        .from(schema.ownAccounts)
        .orderBy(schema.ownAccounts.kontenrahmen, schema.ownAccounts.account);
      const accountCollisions = ownAccounts.filter((account) => reservedAccountNumbers(account.kontenrahmen).has(account.account));
      return {
        rows: [...rows, ...triggers.problems],
        triggerHints: triggers.hints,
        inventoryChecksum: triggers.checksum,
        head,
        entries: entries!.n,
        seals: seals!.n,
        abgleich,
        accountCollisions,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * Prüft die ganze Kette, alle Siegel und gleicht Journal und Steuerwerte ab. Dauert bei großen Datenbanken einige Sekunden.
 * `zusatz`: weitere Zeilen des Abgleichs aus Modulen über auswertungen (übermittelte Jahreserklärungen, erklaerteAbweichungsZeilen).
 */
export async function checkIntegrity(now = today(), zusatz: () => Promise<AbgleichZeile[]> = async () => []): Promise<IntegrityReport> {
  // Mit Buchungen liest der Abgleich die Firmendaten. Fehlen sie, legt loadCompany sie an; das ist ein Schreibzugriff
  // und geht in der Transaktion mit festem Stand nicht. Ohne Buchungen bleibt die Prüfung ohne jeden Schreibzugriff.
  const [booking] = await db.select({ id: schema.journalEntries.id }).from(schema.journalEntries).limit(1);
  if (booking) await loadCompany();
  const { rows, triggerHints, inventoryChecksum, head, entries, seals, abgleich, accountCollisions } = await readSnapshot(now);
  const weitere = await ohneUebernommeneZeilen(await zusatz());
  const files = await lastFileCheck();
  const problems = [...rows].map((r) => ({ ...r, seq: r.seq === null ? null : Number(r.seq) }));
  const perKind = new Map<string, number>();
  for (const p of problems) perKind.set(`${p.art}:${p.tabelle}`, (perKind.get(`${p.art}:${p.tabelle}`) ?? 0) + 1);
  return {
    head,
    entries,
    seals,
    problems,
    truncated: [...perKind.values()].some((n) => n >= MAX_ROWS),
    abgleich: { abweichungen: abweichungen([...abgleich.zeilen, ...weitere.zeilen]), hinweise: abgleich.hinweise },
    accountCollisions,
    triggerHints,
    inventoryChecksum,
    files,
  };
}

export type PruefwertResult =
  /** Eintrag vorhanden, Hash stimmt und die Kette bis dahin ist nachgerechnet lückenlos: bis hierhin unverändert */
  | { status: "ok"; seq: number }
  /** Hash stimmt, aber ein früherer Eintrag passt nicht mehr zur Kette (bei abgeschalteten Triggern geändert) */
  | { status: "beschaedigt"; seq: number; first: number; befund: string }
  /**
   * Hash stimmt und die Kette scheint lückenlos, aber Trigger, Funktionen oder andere Objekte der Datenbank weichen vom
   * Sollbestand ab (checkTriggerIntegrity), oder das Nachrechnen der Kette ist abgebrochen. Wer sie ändern kann, kann auch
   * das Nachrechnen der Kette fälschen.
   */
  | { status: "unbestaetigt"; seq: number; befunde: string[] }
  /** Eintrag vorhanden, Hash anders: die Kette wurde bis zu diesem Eintrag neu berechnet */
  | { status: "abweichend"; seq: number; expected: string; actual: string }
  /** Kein Eintrag mit dieser Nummer: Einträge gelöscht oder ein älteres Backup eingespielt */
  | { status: "fehlt"; seq: number; head: number | null };

/**
 * Vergleicht einen Prüfwert von außerhalb (Mail, Jahresarchiv) mit dem Eintrag dieser Nummer und rechnet die Kette
 * bis dorthin nach. Erst beides zusammen zeigt, dass kein Eintrag bis zu dieser Nummer verändert wurde, und nur, solange
 * Trigger und Funktionen dem Sollbestand entsprechen: Das Nachrechnen läuft über haben_audit_hash in derselben Datenbank.
 */
export async function checkPruefwert(seq: number, hash: string): Promise<PruefwertResult> {
  return db.transaction(
    async (tx): Promise<PruefwertResult> => {
      const [row] = await tx.select({ hash: schema.auditLog.rowHash }).from(schema.auditLog).where(eq(schema.auditLog.seq, seq));
      if (!row) return { status: "fehlt", seq, head: (await chainHead(tx))?.seq ?? null };
      const actual = row.hash.toString("hex");
      if (actual !== hash.toLowerCase()) return { status: "abweichend", seq, expected: hash.toLowerCase(), actual };
      // Zuerst der Katalog: Weicht er ab, ist auch das Nachrechnen der Kette nicht verlässlich
      const catalog = await checkTriggerIntegrity(tx);
      const befunde = catalog.problems.map((p) => `${p.tabelle}: ${p.befund}`);
      // Im Savepoint wie in integrityRows: Bricht die Prüffunktion ab oder fehlt sie, ist der Prüfwert unbestätigt, nie „ok“ (#1716)
      let broken: { seq: string; befund: string } | undefined;
      try {
        [broken] = await tx.transaction((sp) =>
          sp.execute<{ seq: string; befund: string }>(
            sql`select seq, befund from haben_integrity_problems(1) where art = 'kette' and seq <= ${seq} order by seq limit 1`,
          ),
        );
      } catch (error) {
        befunde.push(`haben_integrity_problems: ${PRUEFUNG_ABGEBROCHEN}: ${fehlerGrund(error)}`);
      }
      if (broken) return { status: "beschaedigt", seq, first: Number(broken.seq), befund: broken.befund };
      if (befunde.length > 0) return { status: "unbestaetigt", seq, befunde };
      return { status: "ok", seq };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
