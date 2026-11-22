import {
  activeFooterColumns,
  bekannteLayoutOptionen,
  designWithDefaults,
  isKapitalgesellschaft,
  legalAsColumn,
  legalFooterIssues,
  letterheadDesignInputSchema,
  type LetterheadDesign,
  type LetterheadDesignInput,
} from "@haben/core";
import type { Letterhead } from "@haben/einvoice";
import { eq, sql } from "drizzle-orm";
import { withActor } from "../../db/actor.ts";
import { db, schema, type Db, type Tx } from "../../db/index.ts";
import { UserError } from "../../errors.ts";
import { loadBackground } from "./background.ts";
import { loadLogo } from "./logo.ts";

/** Briefkopf von Rechnungen, Angeboten und Mahnungen: Gestaltung aus dem Standardprofil, dazu das Logo */

export class AccentColorError extends UserError {}

export class FooterError extends UserError {}

async function footerIssues(tx: Db | Tx, design: LetterheadDesign): Promise<string[]> {
  const columns = activeFooterColumns(design);
  if (!columns) return [];
  const [company] = await tx.select({ rechtsform: schema.company.rechtsform }).from(schema.company);
  return legalFooterIssues(columns, {
    kapitalgesellschaft: isKapitalgesellschaft(company?.rechtsform ?? "einzelunternehmen"),
    legalAsColumn: legalAsColumn(design),
  });
}

/**
 * Ein Wechsel des Layouts oder der Fassung, der die Pflichtangaben erst zur eigenen Spalte macht, prüft die Fußzeile
 * wie ein Speichern; sonst stünden neben 4 eigenen Spalten 5 auf dem Blatt (#1651)
 */
/**
 * Wer die Fußzeile prüft und danach schreibt, nimmt zuerst diese Sperre: Sonst lesen zwei gleichzeitige Änderungen denselben
 * Stand, jede geht für sich, und zusammengeführt stünden 5 Spalten auf dem Blatt
 */
export async function lockFooter(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('haben.fusszeile'))`);
}

export async function checkLayoutSwitch(tx: Db | Tx, current: LetterheadDesign, next: LetterheadDesign): Promise<void> {
  if (!legalAsColumn(next) || legalAsColumn(current)) return;
  const issues = await footerIssues(tx, next);
  if (issues.length > 0) throw new FooterError(issues.join(" "));
}

/**
 * Pflichtangaben einer GmbH oder UG in der Fußzeile (#1651): alle Platzhalter oder keiner, als Spalte höchstens 4 Spalten.
 * Nur, wenn die Eingabe die Fußzeile, die Stelle oder das Layout ändert; eine ältere Fußzeile gilt weiter, bis sie gespeichert wird.
 */
async function checkFooter(tx: Tx, changes: LetterheadDesignInput): Promise<void> {
  const current = await loadDesign(tx);
  // Optionen je Layout zusammengeführt wie beim Speichern
  const next = designWithDefaults({ ...current, ...changes, layoutOptions: { ...current.layoutOptions, ...changes.layoutOptions } });
  if ("footerColumns" in changes || changes.footerCustom === true || "legalPosition" in changes) {
    const issues = await footerIssues(tx, next);
    if (issues.length > 0) throw new FooterError(issues.join(" "));
  } else if (changes.layoutOptions) await checkLayoutSwitch(tx, current, next);
}

/** Ohne gespeichertes Profil gelten die Vorgaben; Einstellungen, die eine ältere Zeile nicht kennt, ebenso */
export async function loadDesign(q: Db | Tx = db): Promise<LetterheadDesign> {
  const profiles = schema.letterheadProfiles;
  const [row] = await q.select({ settings: profiles.settings }).from(profiles).where(eq(profiles.isDefault, true));
  return designWithDefaults(row?.settings);
}

/** Heutige Gestaltung für jedes neu erzeugte PDF, auch für Mahnung und Lieferschein zu älteren Belegen; schon festgeschriebene PDFs bleiben */
export async function loadLetterhead(): Promise<Letterhead> {
  const [logo, background, design] = await Promise.all([loadLogo(), loadBackground(), loadDesign()]);
  const { accent, layouts: _layouts, layoutOptions: _layoutOptions, ...options } = design;
  return { accent, options, ...(logo ? { logo } : {}), ...(background ? { background } : {}) };
}

/** Ändert das Standardprofil; was die Eingabe nicht nennt, bleibt. Farben werden groß geschrieben gespeichert */
export async function saveDesign(actor: string, input: LetterheadDesignInput): Promise<LetterheadDesign> {
  const parsed = letterheadDesignInputSchema.safeParse(input);
  if (!parsed.success) throw new AccentColorError("Die Gestaltung ist ungültig. Die Akzentfarbe hat die Form #RRGGBB, z. B. #1F6F5C.");
  return withActor(actor, async (tx) => {
    const { layoutOptions, ...input } = parsed.data;
    // Spalten speichern heißt eigene Fußzeile an, null heißt aus; so bleibt die Eingabe von vor #1651 gültig
    const rest: LetterheadDesignInput =
      "footerColumns" in input && !("footerCustom" in input) ? { ...input, footerCustom: input.footerColumns !== null } : input;
    // Eine eigene Farbe gilt ab jetzt statt der des Layouts; „Wie im Layout“ schaltet sie erst ausdrücklich wieder ab
    const changes: LetterheadDesignInput = rest.accent ? { accentFromLayout: false, ...rest, accent: rest.accent.toUpperCase() } : rest;
    const optionen = layoutOptions ? bekannteLayoutOptionen(layoutOptions) : undefined;
    if (optionen) changes.layoutOptions = optionen;
    await lockFooter(tx);
    await checkFooter(tx, changes);
    const profiles = schema.letterheadProfiles;
    // In der Datenbank zusammenführen: Lesen und danach Schreiben ließe zwei gleichzeitige Änderungen sich überschreiben
    const [row] = await tx
      .insert(profiles)
      .values({ name: "Standard", isDefault: true, settings: designWithDefaults(changes) })
      .onConflictDoUpdate({
        target: profiles.isDefault,
        targetWhere: sql`${profiles.isDefault}`,
        // Optionen je Layout zusammenführen: Die Wahl für Atelier überschreibt nicht die für Elegant
        set: {
          settings: optionen
            ? sql`letterhead_profiles.settings || ${JSON.stringify(changes)}::jsonb || jsonb_build_object('layoutOptions', coalesce(letterhead_profiles.settings -> 'layoutOptions', '{}'::jsonb) || ${JSON.stringify(optionen)}::jsonb)`
            : sql`letterhead_profiles.settings || ${JSON.stringify(changes)}::jsonb`,
          updatedAt: new Date(),
        },
      })
      .returning({ settings: profiles.settings });
    return designWithDefaults(row?.settings);
  });
}

export async function saveAccentColor(actor: string, color: string): Promise<void> {
  await saveDesign(actor, { accent: color });
}
