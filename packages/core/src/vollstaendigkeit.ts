import type { BwaForm } from "./bwa-kennzahlen.ts";
import type { Zeitraum } from "./bwa-zeitraum.ts";
import { addDays, isNonWorkingDay } from "./holidays.ts";

/*
 * Was in einem Zeitraum noch fehlt und die Zahlen einer Auswertung verfälscht (#1635): offene Bankumsätze, ungebuchte Belege,
 * Rechnungsentwürfe und Konten, deren Umsätze vor dem Ende des Zeitraums aufhören. Rechnet ohne Datenbank, damit BWA,
 * Liquidität, Vollständigkeitsampel, Export und MCP dieselben Hinweise bekommen. Die Zählung liefert der Server
 * (modules/vollstaendigkeit), dieselbe wie in der Vorprüfung der Voranmeldung.
 */

/** Was im Zeitraum noch offen ist; Belege ohne Datum zählen mit */
export interface OffeneVorgaenge {
  /** Bankumsätze aus, ohne Beleg oder Zuordnung */
  ausgaben: number;
  /** Bankumsätze ein, nicht zugeordnet */
  eingaenge: number;
  /** Belege im Status „neu“ */
  belege: number;
  rechnungsentwuerfe: number;
}

/** Wie weit die Umsätze eines Kontos reichen: Ende des letzten Imports oder letzter Umsatz; null ohne Import */
export interface KontoAbdeckung {
  id: string;
  name: string;
  bis: string | null;
}

export type UnvollstaendigArt = "ausgaben" | "eingaenge" | "belege" | "rechnungsentwuerfe" | "konto";

export interface UnvollstaendigHinweis {
  art: UnvollstaendigArt;
  /** warn: die Zahlen sind sicher zu niedrig oder zu hoch; info: sie können es sein */
  ton: "warn" | "info";
  /** Anzahl der Vorgänge; bei „konto“ 1 */
  anzahl: number;
  /** Nur bei „konto“ */
  konto?: { id: string; name: string; bis: string };
  /** Wo es sich beheben lässt; die Seite zeigt den Link nur, wer die Seite sieht */
  link: "/bank" | "/belege" | "/rechnungen";
}

/**
 * Bis zu welchem Tag Umsätze da sein sollten: das Ende des Zeitraums, im laufenden Zeitraum gestern, jeweils zurück auf den
 * letzten Bankarbeitstag. Am Wochenende und an bundesweiten Feiertagen bucht keine Bank, sonst meldete fast jeder Monat ein
 * Konto, dessen letzter Auszug am Freitag endet. null, wenn davon nichts im Zeitraum liegt.
 */
export function stichtag(zeitraum: Zeitraum, heute: string): string | null {
  let tag = addDays(heute, -1);
  if (zeitraum.bis < tag) tag = zeitraum.bis;
  while (isNonWorkingDay(tag, null)) tag = addDays(tag, -1);
  return tag < zeitraum.von ? null : tag;
}

/**
 * Konten, deren Umsätze vor dem Stichtag aufhören, auch schon vor dem Zeitraum: Ein stillgelegtes Konto schließt man unter
 * Bank aus, dann zählt es nicht mehr. Ohne Import fehlt nichts Bekanntes, also kein Hinweis. Lücken mitten im Zeitraum
 * erkennt das nicht.
 */
export function kontenNurBis(konten: readonly KontoAbdeckung[], zeitraum: Zeitraum, heute: string): { id: string; name: string; bis: string }[] {
  const tag = stichtag(zeitraum, heute);
  if (!tag) return [];
  return konten.flatMap((k) => (k.bis !== null && k.bis < tag ? [{ id: k.id, name: k.name, bis: k.bis }] : []));
}

/**
 * Die Hinweise für eine Form der BWA. Form 43 rechnet nach Zahlung: Jeder offene Bankumsatz fehlt in Erlösen oder Kosten,
 * Rechnungsentwürfe ändern nichts. Form 01 rechnet periodengerecht: Ein Zahlungseingang zu einer festgeschriebenen Rechnung
 * ist schon Erlös, ein Entwurf mit Datum im Zeitraum fehlt vielleicht; beides nur als Hinweis.
 */
export function unvollstaendig(offen: OffeneVorgaenge, konten: readonly { id: string; name: string; bis: string }[], form: BwaForm): UnvollstaendigHinweis[] {
  const hinweise: UnvollstaendigHinweis[] = [];
  const dazu = (art: UnvollstaendigArt, anzahl: number, ton: UnvollstaendigHinweis["ton"], link: UnvollstaendigHinweis["link"]) => {
    if (anzahl > 0) hinweise.push({ art, ton, anzahl, link });
  };
  dazu("ausgaben", offen.ausgaben, "warn", "/bank");
  dazu("eingaenge", offen.eingaenge, form === "form43" ? "warn" : "info", "/bank");
  dazu("belege", offen.belege, "warn", "/belege");
  if (form === "form01") dazu("rechnungsentwuerfe", offen.rechnungsentwuerfe, "info", "/rechnungen");
  for (const konto of konten) hinweise.push({ art: "konto", ton: "warn", anzahl: 1, konto, link: "/bank" });
  return hinweise;
}

/** TT.MM., mit Jahr, sobald Tag oder Zeitraum nicht in einem Jahr liegen; sonst wäre „nur bis 20.01.“ über den Jahreswechsel offen */
const tagImZeitraum = (datum: string, zeitraum: Zeitraum) => {
  const tagMonat = `${datum.slice(8, 10)}.${datum.slice(5, 7)}.`;
  const jahr = datum.slice(0, 4);
  return jahr === zeitraum.von.slice(0, 4) && jahr === zeitraum.bis.slice(0, 4) ? tagMonat : `${tagMonat}${jahr}`;
};

/** Ein Satz je Hinweis zum Zeitraum der Auswertung, für Seite und Export gleich */
export function unvollstaendigText(h: UnvollstaendigHinweis, zeitraum: Zeitraum): string {
  const n = h.anzahl;
  switch (h.art) {
    case "ausgaben":
      return `${n} ${n === 1 ? "Ausgabe" : "Ausgaben"} im Zeitraum ohne Beleg oder Zuordnung; ${n === 1 ? "sie fehlt" : "sie fehlen"} in den Kosten.`;
    case "eingaenge":
      return h.ton === "warn"
        ? `${n} ${n === 1 ? "Zahlungseingang" : "Zahlungseingänge"} im Zeitraum noch nicht zugeordnet; ${n === 1 ? "er fehlt" : "sie fehlen"} in den Erlösen.`
        : `${n} ${n === 1 ? "Zahlungseingang" : "Zahlungseingänge"} im Zeitraum noch nicht zugeordnet; ohne Rechnung fehlt der Erlös.`;
    case "belege":
      return `${n} ${n === 1 ? "Beleg" : "Belege"} im Zeitraum oder ohne Datum noch nicht gebucht.`;
    case "rechnungsentwuerfe":
      return `${n} ${n === 1 ? "Rechnungsentwurf" : "Rechnungsentwürfe"} mit Datum im Zeitraum; Erlöse zählen erst festgeschrieben.`;
    case "konto":
      return `Umsätze von Konto „${h.konto?.name}“ nur bis ${tagImZeitraum(h.konto?.bis ?? "", zeitraum)}`;
  }
}
