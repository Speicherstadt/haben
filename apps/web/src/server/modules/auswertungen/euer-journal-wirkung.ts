import {
  ACCOUNTS,
  euerAusZeilen,
  isExternalSettlementPayment,
  leereEuerAusJournal,
  zahlungsAnteil,
  type EuerAusJournal,
  type EuerHerkunft,
  type Kontenrahmen,
} from "@haben/core";
import type { Db, Tx } from "../../db/index.ts";
import { type Buchung, offenerPosten, type Verrechnung as RechnungsVerrechnung, type Zeile } from "./euer-journal-buchungen.ts";
import { belegTeilzahlung, uebernommeneZeilen, type BelegNebenbuch } from "./euer-journal-nebenbuch.ts";
import { offenerSaldo as offen, rechnungsAnteile } from "./euer-journal-anteile.ts";
import type { importAnteile } from "./euer-import.ts";

/*
 * Was eine Buchung bzw. eine Verrechnung in der EÜR aus dem Journal bewirkt (euerAusJournal in euer-journal.ts), mit den
 * Daten, die euerAusJournal für das Jahr einmal lädt (EuerLauf).
 */

const ausbuchungOhneZahlung = (b: Buchung) => {
  const a = ACCOUNTS[b.kontenrahmen];
  return b.zeilen.some((z) => z.account === a.skontiGewaehrt || z.account === a.skontiErhalten || z.account === a.forderungsverluste);
};

export interface Ziel {
  invoiceId: string | null;
  documentId: string | null;
  loanId?: string | null;
}

/**
 * Herkunft einer Buchung in der EÜR: Pauschale, Anlage (auch ein Beleg der Kategorie Anlage ohne offenen Posten, etwa privat
 * bezahlt; sein GWG-Konto ist Anlagevermögen, #1397), Zahlung auf ein Darlehen für Anlagevermögen oder sonst
 */
const herkunftVon = (b: Buchung, ziel: Ziel | undefined, anlageDarlehen: ReadonlySet<string>, anlagen: ReadonlySet<string>): EuerHerkunft =>
  b.sourceType === "pauschale"
    ? "pauschale"
    : b.sourceType === "asset"
      ? "asset"
      : b.sourceType === "document" && anlagen.has(b.sourceId)
        ? "anlage"
        : ziel?.loanId && anlageDarlehen.has(ziel.loanId)
          ? "darlehenAnlagevermoegen"
          : "sonst";

/**
 * Verrechnung zweier Belege (#274): Gutschrift und Rechnung gleichen sich gegenseitig, ohne dass Geld fließt. In der EÜR
 * wirkt sie wie eine Zahlung auf jeden der beiden Belege, am Tag der Aufrechnung; gebucht wird sie nicht (Verbindlichkeiten
 * an Verbindlichkeiten), deshalb steht sie nur in `document_settlements`.
 */
export interface Verrechnung {
  id: string;
  dokumentId: string;
  date: string;
  /** Betrag wie gespeichert: negativ beim Beleg, positiv bei der Gutschrift; ausgeglichen ist `-betrag` */
  betrag: number;
}

interface Ursprung {
  /** Kontenrahmen der ausgeglichenen Buchung; er kann zum Jahreswechsel gewechselt haben */
  kontenrahmen: Kontenrahmen;
  zeilen: Zeile[];
  gesamt: number;
  herkunft: EuerHerkunft;
  /** Rechnung: Anteil jeder ausgleichenden Buchung an den Zeilen, wie gespeichert (settlementTaxShares) */
  anteile?: Map<string, number[]>;
  beleg?: BelegNebenbuch;
}

/** Was euerAusJournal für ein Jahr geladen hat, und was die Wirkungen dabei zählen */
export interface EuerLauf {
  year: number;
  q: Db | Tx;
  kuMonate: boolean[];
  importiert: Awaited<ReturnType<typeof importAnteile>>;
  zielVon: Map<string, Ziel>;
  anlageDarlehen: Set<string>;
  gebuchtVon: { invoice: Map<string, Buchung[]>; document: Map<string, Buchung[]> };
  ausgleicheVon: Map<string, Buchung[]>;
  verrechnungenVon: Map<string, RechnungsVerrechnung[]>;
  nebenbuchVon: Map<string, BelegNebenbuch>;
  anlagen: Set<string>;
  zaehler: { ungeklaerteImporte: number };
  ursprung: Map<string, Ursprung>;
}

const alsZeilen = (zeilen: Zeile[], anteil: number[]): Zeile[] =>
  zeilen.map((z, i) => ({ ...z, debit: Math.max(anteil[i]!, 0), credit: Math.max(-anteil[i]!, 0) }));

/** Summiert die Wirkung `von` in `nach`, bei einer aufgehobenen Zuordnung mit umgekehrtem Vorzeichen */
export function dazu(nach: EuerAusJournal, von: EuerAusJournal, vorzeichen: 1 | -1 = 1) {
  for (const [key, betrag] of Object.entries(von.zeilen) as [keyof EuerAusJournal["zeilen"], number][])
    nach.zeilen[key] = (nach.zeilen[key] ?? 0) + vorzeichen * betrag;
  nach.bewirtungNichtAbziehbar += vorzeichen * von.bewirtungNichtAbziehbar;
  nach.gewerbesteuerNichtAbziehbar += vorzeichen * von.gewerbesteuerNichtAbziehbar;
}

/**
 * Das Zwischenkonto der noch nicht abziehbaren Vorsteuer (SKR03 1548, SKR04 1434; #693, #786) zählt wie die Vorsteuer: In
 * der EÜR ist gezahlte Vorsteuer Betriebsausgabe im Jahr der Zahlung (§ 11 Abs. 2 EStG), gleich, ob sie bis zur Ausführung
 * geparkt ist. Die Umbuchung vom Zwischenkonto auf die Vorsteuer (Freigabe, Zahlung vor der Ausführung) hebt sich so auf;
 * eine Zahlung zieht ihren Anteil an der geparkten Steuer, gerundet wie die Steuer der Nebenbücher (zahlungsStand).
 * Liefert die Zeilen ohne Forderungen und Verbindlichkeiten (offenerPosten).
 */
function zwischenkontoAlsVorsteuer(kr: Kontenrahmen, zeilen: readonly Zeile[]): Zeile[] {
  const a = ACCOUNTS[kr];
  return zeilen.filter((z) => !offenerPosten(kr, z)).map((z) => (z.account === a.vorsteuerNochNichtAbziehbar ? { ...z, account: a.vorsteuer[1900] } : z));
}

/** Rechnung bzw. Beleg, den eine Zahlung ausgleicht, einmal je Lauf aufbereitet */
async function ursprungVon(l: EuerLauf, typ: "invoice" | "document", id: string, kr: Kontenrahmen): Promise<Ursprung> {
  const key = `${typ}|${id}`;
  const vorhanden = l.ursprung.get(key);
  if (vorhanden) return vorhanden;
  const gebucht = l.gebuchtVon[typ].get(id) ?? [];
  const kontenrahmen = gebucht[0]?.kontenrahmen ?? kr;
  const alle = gebucht.flatMap((b) => b.zeilen);
  const istUebernommen = gebucht.length === 0 || alle.some((z) => z.account === ACCOUNTS[kontenrahmen].saldenvortrag);
  // Aus Lexoffice übernommen: verteilt wird auf die Zeilen, die Haben gebucht hätte
  const ersatz = istUebernommen ? await uebernommeneZeilen(l.q, typ, id, kontenrahmen) : null;
  const zeilen = ersatz?.zeilen ?? zwischenkontoAlsVorsteuer(kontenrahmen, alle);
  const gesamt = ersatz ? ersatz.gesamt : alle.filter((z) => offenerPosten(kontenrahmen, z)).reduce((s, z) => s + z.debit - z.credit, 0);
  const herkunft: EuerHerkunft = typ === "document" && l.anlagen.has(id) ? "anlage" : "sonst";
  const u: Ursprung = {
    kontenrahmen,
    zeilen,
    gesamt,
    herkunft,
    ...(typ === "invoice" && gesamt !== 0
      ? { anteile: rechnungsAnteile(kontenrahmen, zeilen, gesamt, l.ausgleicheVon.get(id) ?? [], l.verrechnungenVon.get(id) ?? []) }
      : {}),
    ...(typ === "document" ? { beleg: l.nebenbuchVon.get(id) } : {}),
  };
  l.ursprung.set(key, u);
  return u;
}

/** Was eine Verrechnung zweier Belege bewirkt: wie eine Zahlung von `-betrag` auf den Beleg, ohne eigene Buchung */
export async function wirkungVerrechnung(l: EuerLauf, v: Verrechnung, belegKontenrahmen: Kontenrahmen): Promise<EuerAusJournal> {
  const summe = leereEuerAusJournal();
  const u = await ursprungVon(l, "document", v.dokumentId, belegKontenrahmen);
  if (u.gesamt === 0) return summe;
  // betrag trägt das Vorzeichen des offenen Postens wie eine Buchung, ausgeglichen ist das Umgekehrte
  if (u.beleg && (u.beleg.effects?.has(v.id) || v.betrag !== u.gesamt)) belegTeilzahlung(l.year, u.beleg, -v.betrag, summe, v.id);
  else
    euerAusZeilen(u.kontenrahmen, zahlungsAnteil(u.kontenrahmen, u.zeilen, u.gesamt, v.betrag), u.herkunft, summe, l.kuMonate[Number(v.date.slice(5, 7)) - 1]);
  return summe;
}

/** Was eine Buchung in der EÜR bewirkt */
export async function wirkung(l: EuerLauf, b: Buchung): Promise<EuerAusJournal> {
  const summe = leereEuerAusJournal();
  // Freigabe zum Leistungsdatum (#693): nur eine Umbuchung vom Zwischenkonto auf die Vorsteuer, kein Abfluss
  if (b.sourceType === "freigabe") return summe;
  const kr = b.kontenrahmen;
  const kleinunternehmer = l.kuMonate[Number(b.date.slice(5, 7)) - 1];
  const ziel = l.zielVon.get(b.sourceId);
  const herkunft = herkunftVon(b, ziel, l.anlageDarlehen, l.anlagen);
  const ausgeglichen = offen(b);
  const hatOffenenPosten = b.zeilen.some((z) => offenerPosten(kr, z));
  const importAnteil = l.importiert.get(b.id);
  if (b.sourceType === "import" && !importAnteil && isExternalSettlementPayment(kr, b.zeilen)) l.zaehler.ungeklaerteImporte++;
  // Rechnung bzw. Beleg auf Ziel: wirkt erst mit der Zahlung
  if (
    hatOffenenPosten &&
    (b.sourceType === "invoice" || b.sourceType === "document" || b.sourceType === "asset" || (b.sourceType === "import" && !importAnteil))
  )
    return summe;
  if (ausbuchungOhneZahlung(b)) return summe;
  // Eigene Zeilen der Buchung (Kursdifferenz, Umbuchung der Umsatzsteuer, die sich aufhebt) nach ihren Konten
  const eigene = zwischenkontoAlsVorsteuer(kr, b.zeilen);
  const umkehr = b.sourceType === "allocation" && b.reversesId !== null;
  // Rücknahme in derselben EÜR-Zeile: Eine aufgehobene Zahlung ist keine echte Finanzamtserstattung und umgekehrt.
  // Amtliche Anleitung EÜR 2025, Zeilen 18 und 58: https://www.elster.de/eportal/helpGlobal?themaGlobal=help_euer_ufa_77_2025
  dazu(
    summe,
    euerAusZeilen(
      kr,
      umkehr
        ? alsZeilen(
            eigene,
            eigene.map((z) => z.credit - z.debit),
          )
        : eigene,
      herkunft,
      undefined,
      kleinunternehmer,
    ),
    umkehr ? -1 : 1,
  );
  if (importAnteil) {
    euerAusZeilen(importAnteil.kontenrahmen, alsZeilen(importAnteil.zeilen, importAnteil.anteil), "sonst", summe, kleinunternehmer);
    return summe;
  }
  if (!hatOffenenPosten || ausgeglichen === 0) return summe;
  const typ = ziel?.invoiceId ? "invoice" : ziel?.documentId ? "document" : null;
  const zielId = ziel?.invoiceId ?? ziel?.documentId;
  if (!typ || !zielId) return summe;
  const u = await ursprungVon(l, typ, zielId, kr);
  // Storniert: nichts mehr offen, Zahlung und Gegenbuchung heben sich auf
  if (u.gesamt === 0) return summe;
  const anteil = u.anteile?.get(b.id);
  // Teilzahlung auf einen Beleg mit Privatanteil oder ohne Vorsteuerabzug: gerundet wie computeEuer
  if (!anteil && u.beleg && (u.beleg.effects?.has(b.sourceId) || -ausgeglichen !== u.gesamt)) {
    belegTeilzahlung(l.year, u.beleg, ausgeglichen, summe, b.sourceId);
    return summe;
  }
  // Beleg: jede Zahlung für sich (paidTaxShares)
  const zeilen = anteil ? alsZeilen(u.zeilen, anteil) : zahlungsAnteil(u.kontenrahmen, u.zeilen, u.gesamt, -ausgeglichen);
  euerAusZeilen(u.kontenrahmen, zeilen, u.herkunft, summe, kleinunternehmer);
  return summe;
}
