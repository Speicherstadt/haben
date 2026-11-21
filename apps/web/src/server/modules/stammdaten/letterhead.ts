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

/**
 * Pflichtangaben einer GmbH oder UG in der Fußzeile (#1651): alle Platzhalter oder keiner, als Spalte höchstens 4 Spalten.
 * Nur, wenn die Eingabe die Fußzeile oder die Stelle ändert; eine ältere Fußzeile gilt weiter, bis sie gespeichert wird.
 */
async function checkFooter(tx: Tx, changes: LetterheadDesignInput): Promise<void> {
  if (!("footerColumns" in changes || changes.footerCustom === true || "legalPosition" in changes)) return;
  const next = designWithDefaults({ ...(await loadDesign(tx)), ...changes });
  const columns = activeFooterColumns(next);
  if (!columns) return;
  const [company] = await tx.select({ rechtsform: schema.company.rechtsform }).from(schema.company);
  const issues = legalFooterIssues(columns, { kapitalgesellschaft: isKapitalgesellschaft(company?.rechtsform ?? "einzelunternehmen"), legalAsColumn: legalAsColumn(next) });
  if (issues.length > 0) throw new FooterError(issues.join(" "));
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
