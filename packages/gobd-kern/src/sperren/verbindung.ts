/** Eine Abfrage mit Platzhaltern $1, $2, … und ihren Werten; liefert die Zeilen */
export type Abfrage = <T = Record<string, unknown>>(text: string, werte?: unknown[]) => Promise<T[]>;

/**
 * Öffnet eine lesende Transaktion mit REPEATABLE READ, damit alle Abfragen denselben Stand sehen, und reicht ihre Abfrage
 * weiter. Mit postgres.js: `{ transaktion: (lesen) => sql.begin("isolation level repeatable read read only", (tx) =>
 * lesen((text, werte = []) => tx.unsafe(text, werte as never[]))) }`.
 */
export interface Leser {
  transaktion<T>(lesen: (abfrage: Abfrage) => Promise<T>): Promise<T>;
}

/** Schema der geprüften Tabellen und Präfix der eigenen Funktionen, etwa `{ schema: "public", praefix: "belegt" }` */
export interface SperrenOptionen {
  schema: string;
  praefix: string;
}
