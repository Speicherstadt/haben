import { LEGAL_PLACEHOLDERS, type LegalPlaceholder, MAX_FOOTER_COLUMNS } from "./footer-template.ts";
import { type EingebautesLayout, eingebautesLayout, layoutOptionen, layoutPflichtangaben, type PflichtangabenStelle } from "./layout-katalog.ts";
import { LAYOUT_DOCUMENT_TYPES, type LegalPosition, type LetterheadDesign } from "./letterhead-design.ts";

/*
 * Pflichtangaben einer GmbH oder UG (§ 35a Abs. 1 GmbHG) im Fuß der Belege (#1651). Stehen ihre Platzhalter in der
 * eigenen Fußzeile, gilt deren Stelle; sonst setzt Haben sie selbst, als Spalte neben den übrigen oder als Zeile darunter.
 * Teilweise geht nicht: Fehlte eine Angabe, stünde sie nirgends (Zwangsgeld nach § 79 Abs. 1 GmbHG).
 */

const legalIn = (columns: readonly string[]): Set<LegalPlaceholder> =>
  new Set(LEGAL_PLACEHOLDERS.filter((name) => columns.some((column) => column.includes(`{${name}}`))));

/**
 * Stehen alle Platzhalter der Pflichtangaben in den Spalten? Dann setzt Haben sie nicht noch einmal. Nur einige, etwa aus
 * der Zeit als Einzelunternehmen: Haben setzt sie trotzdem, lieber doppelt als eine fehlend.
 */
export const legalInFooter = (columns: readonly string[]): boolean => legalIn(columns).size === LEGAL_PLACEHOLDERS.length;

/** Platzhalter der Pflichtangaben, die in den Spalten fehlen */
export function missingLegalPlaceholders(columns: readonly string[]): LegalPlaceholder[] {
  const present = legalIn(columns);
  return LEGAL_PLACEHOLDERS.filter((name) => !present.has(name));
}

const list = (names: readonly string[]) => {
  const tags = names.map((name) => `{${name}}`);
  return tags.length < 2 ? (tags[0] ?? "") : `${tags.slice(0, -1).join(", ")} und ${tags.at(-1)}`;
};

/**
 * Warum sich die Spalten bei dieser Rechtsform nicht speichern lassen; leer = in Ordnung. Ergänzt footerIssues, das die
 * Rechtsform nicht kennt. legalAsColumn: Haben setzte die Pflichtangaben als eigene Spalte (legalAsColumn unten).
 */
export function legalFooterIssues(
  columns: readonly string[],
  { kapitalgesellschaft, legalAsColumn }: { kapitalgesellschaft: boolean; legalAsColumn: boolean },
): string[] {
  if (!kapitalgesellschaft) return [];
  const missing = missingLegalPlaceholders(columns);
  if (missing.length > 0 && missing.length < LEGAL_PLACEHOLDERS.length)
    return [`Pflichtangaben nach § 35a GmbHG unvollständig, es fehlen ${list(missing)}. Setze alle ein oder keinen, dann setzt Haben sie selbst.`];
  if (missing.length > 0 && legalAsColumn && columns.length >= MAX_FOOTER_COLUMNS)
    return [
      `Die Pflichtangaben der Gesellschaft stehen als eigene Spalte daneben, mehr als ${MAX_FOOTER_COLUMNS} Spalten passen nicht: Kürze auf ${MAX_FOOTER_COLUMNS - 1} Spalten oder setze die Platzhalter der Pflichtangaben ein.`,
    ];
  return [];
}

/** Stelle der Pflichtangaben in einem eingebauten Layout: die gewählte, außer das Layout setzt den Fuß in eine Randspalte */
export function legalStelle(layout: EingebautesLayout, optionen: Readonly<Record<string, string>>, gewaehlt: LegalPosition): PflichtangabenStelle {
  const vorgabe = layoutPflichtangaben(layout, optionen);
  return vorgabe === "rand" || gewaehlt === "layout" ? vorgabe : gewaehlt;
}

/** Stelle der Pflichtangaben je Belegart mit eingebautem Layout; eigene Layouts fehlen, sie setzen sie selbst */
export function legalStellen(design: Pick<LetterheadDesign, "layouts" | "layoutOptions" | "legalPosition">): PflichtangabenStelle[] {
  return LAYOUT_DOCUMENT_TYPES.flatMap((type) => {
    const ref = design.layouts[type];
    const layout = ref.kind === "eingebaut" ? eingebautesLayout(ref.id) : undefined;
    return layout ? [legalStelle(layout, layoutOptionen(layout, design.layoutOptions[layout.id]), design.legalPosition)] : [];
  });
}

/** Setzt ein eingebautes Layout einer Belegart die Pflichtangaben als Spalte? Dann zählen sie zu den höchstens 4 Spalten */
export const legalAsColumn = (design: Pick<LetterheadDesign, "layouts" | "layoutOptions" | "legalPosition">): boolean =>
  legalStellen(design).includes("spalte");
