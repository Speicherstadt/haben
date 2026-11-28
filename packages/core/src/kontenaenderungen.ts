import type { Kontenrahmen } from "./kontenplan.ts";

/*
 * Kontenänderungen (#2043, docs/adr/kontenrahmen-ausgaben.md): die eine Liste der Konten, die Haben für einen Zweck früher
 * bebucht hat. DATEV gibt SKR03 und SKR04 je Jahr heraus („Gültig für 2026“); ein Konto kommt mit einer Ausgabe dazu, wird
 * reserviert und kann nach zwei Jahren neu belegt werden (DATEV Dok.-Nr. 1029365). Daraus folgt:
 *
 * - Eine neue Buchung steht auf dem Konto, das in ihrem Buchungsjahr galt (kontoImBuchungsjahr, eingesetzt in ledger.post).
 * - Bestehende Buchungen bleiben, wie sie sind. Auswertungen lesen ein früheres Konto als sein heutiges (heutigesKonto).
 * - Frühere Nummern bleiben für eigene Konten gesperrt, behalten ihren Namen und wandern beim Wechsel des Kontenrahmens mit.
 *
 * Die Zuordnung geht über die Kontonummer. Teilen sich zwei Zwecke heute ein Konto und ändert sich nur einer, reicht die
 * Liste nicht: Dann wählt die buchende Stelle das Konto selbst nach dem Jahr.
 */

export interface KontoStand {
  /** Konto in der Ausgabe, nach der Haben heute zuordnet */
  heute: string;
  /** Früheres Konto mit seiner letzten Bezeichnung; fehlt, wo sich in diesem Kontenrahmen nichts geändert hat */
  frueher?: { konto: string; name: string };
}

export interface Kontenaenderung {
  zweck: string;
  SKR03: KontoStand;
  SKR04: KontoStand;
  /**
   * Letztes Buchungsjahr des früheren Kontos, wenn DATEV das heutige erst ab dem Folgejahr führt: Eine neue Buchung mit
   * Datum bis zu diesem Jahr geht auf das frühere Konto. Ohne Angabe passte das frühere Konto nie zum Kontenrahmen (eine
   * Korrektur in Haben); neu bebucht wird es in keinem Jahr.
   */
  bisJahr?: number;
  /**
   * Das frühere Konto hat bei DATEV eine eigene Bedeutung und wird auch sonst bebucht: Nur Buchungen dieser Herkunft
   * (source_type) zählen dort wie auf dem heutigen Konto, und nur sie gehen für frühere Jahre dorthin.
   */
  nurHerkunft?: "pauschale";
  /** Woher die Änderung kommt: Fundstelle bei DATEV und das Issue, mit dem Haben umgestellt hat */
  quelle: string;
}

/** Programmänderungen zu Kanzlei-Rechnungswesen 13.3 (Kontenrahmen 2025), Abschnitt „Jahresabschluss: Weitere neue Kontenzwecke“ */
const DATEV_2025 = "https://apps.datev.de/myupdates/product-change/details/rel.1037625.productversion_i20241002140543480010133";

export const KONTENAENDERUNGEN: readonly Kontenaenderung[] = [
  {
    zweck: "Homeoffice-Tagespauschale",
    SKR03: { heute: "4287", frueher: { konto: "4288", name: "Aufwendungen für ein häusliches Arbeitszimmer (abziehbarer Anteil)" } },
    SKR04: { heute: "6347", frueher: { konto: "6348", name: "Aufwendungen für ein häusliches Arbeitszimmer (abziehbarer Anteil)" } },
    bisJahr: 2024,
    nurHerkunft: "pauschale",
    quelle: `DATEV: Konto 4287 bzw. 6347 „ab dem Jahr 2025“ (${DATEV_2025}); in Haben mit #2015`,
  },
  {
    zweck: "Erlöse als Kleinunternehmer",
    SKR03: { heute: "8192", frueher: { konto: "8195", name: "Erlöse als Kleinunternehmer § 19 UStG" } },
    SKR04: { heute: "4184", frueher: { konto: "4185", name: "Erlöse als Kleinunternehmer § 19 UStG" } },
    bisJahr: 2024,
    quelle: `DATEV: Konto 8192 bzw. 4184 „ab dem Jahr 2025 eingeführt“ (${DATEV_2025}); in Haben mit #899`,
  },
  {
    // DATEV-Kontenrahmen SKR04: 4610 ist die Entnahme von Waren zu 7 %, 4630 die Verwendung von Gegenständen zu 7 %
    zweck: "Sachentnahme 7 %",
    SKR03: { heute: "8915" },
    SKR04: { heute: "4610", frueher: { konto: "4630", name: "Verwendung von Gegenständen für Zwecke außerhalb des Unternehmens 7 % USt" } },
    quelle: "Korrektur in Haben mit #598",
  },
];

export interface FrueheresKonto {
  konto: string;
  name: string;
  /** Das Konto, das Haben heute für denselben Zweck bebucht */
  heute: string;
  aenderung: Kontenaenderung;
}

const FRUEHERE: Record<Kontenrahmen, readonly FrueheresKonto[]> = { SKR03: fruehereIm("SKR03"), SKR04: fruehereIm("SKR04") };

function fruehereIm(kontenrahmen: Kontenrahmen): FrueheresKonto[] {
  return KONTENAENDERUNGEN.flatMap((aenderung) => {
    const { heute, frueher } = aenderung[kontenrahmen];
    return frueher ? [{ ...frueher, heute, aenderung }] : [];
  });
}

/** Die früheren Konten eines Kontenrahmens */
export function fruehereKonten(kontenrahmen: Kontenrahmen): readonly FrueheresKonto[] {
  return FRUEHERE[kontenrahmen];
}

/**
 * Frühere Konten, die überall wie ihr heutiges gelten: alle außer denen, die bei DATEV eine eigene Bedeutung haben
 * (Arbeitszimmer); dort entscheidet die Herkunft der Buchung.
 */
export function gleichgestellteKonten(kontenrahmen: Kontenrahmen): readonly FrueheresKonto[] {
  return FRUEHERE[kontenrahmen].filter((f) => !f.aenderung.nurHerkunft);
}

/** Eine Zuordnung nach Konto, ergänzt um die früheren Konten: Jedes steht wie sein heutiges, etwa auf dessen E-Bilanz-Position */
export function mitFrueherenKonten<T>(kontenrahmen: Kontenrahmen, zuordnung: Readonly<Record<string, T>>): Record<string, T> {
  const ergaenzt = { ...zuordnung };
  for (const { konto, heute } of gleichgestellteKonten(kontenrahmen)) {
    const wert = zuordnung[heute];
    if (wert !== undefined) ergaenzt[konto] = wert;
  }
  return ergaenzt;
}

/** Nummer und Name der früheren Konten, für Journal, Kontenblatt und Suche */
export function fruehereKontoNamen(kontenrahmen: Kontenrahmen): Record<string, string> {
  return Object.fromEntries(FRUEHERE[kontenrahmen].map((f) => [f.konto, f.name]));
}

const gilt = (aenderung: Kontenaenderung, herkunft: string | undefined) => !aenderung.nurHerkunft || aenderung.nurHerkunft === herkunft;

/**
 * Für Auswertungen: ein früheres Konto als das, das Haben heute für denselben Zweck bebucht; jedes andere unverändert.
 * `herkunft` ist die Herkunft der Buchung (source_type), wo ein früheres Konto sonst eine eigene Bedeutung hat.
 */
export function heutigesKonto(kontenrahmen: Kontenrahmen, konto: string, herkunft?: string): string {
  return FRUEHERE[kontenrahmen].find((f) => f.konto === konto && gilt(f.aenderung, herkunft))?.heute ?? konto;
}

/**
 * Für neue Buchungen: das Konto, das im Buchungsjahr galt. `konto` ist das heutige; führt DATEV es erst ab einem späteren
 * Jahr, gilt für `jahr` das frühere. Jedes andere Konto, auch ein früheres, bleibt.
 */
export function kontoImBuchungsjahr(kontenrahmen: Kontenrahmen, konto: string, jahr: number, herkunft?: string): string {
  const frueher = FRUEHERE[kontenrahmen].find(
    (f) => f.heute === konto && f.aenderung.bisJahr !== undefined && jahr <= f.aenderung.bisJahr && gilt(f.aenderung, herkunft),
  );
  return frueher?.konto ?? konto;
}

/** Die Zeilen einer neuen Buchung mit den Konten ihres Buchungsjahres */
export function zeilenImBuchungsjahr<Z extends { account: string }>(kontenrahmen: Kontenrahmen, jahr: number, herkunft: string, zeilen: readonly Z[]): Z[] {
  return zeilen.map((zeile) => {
    const account = kontoImBuchungsjahr(kontenrahmen, zeile.account, jahr, herkunft);
    return account === zeile.account ? zeile : { ...zeile, account };
  });
}
