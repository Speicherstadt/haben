import { entnahmeUmsatz, isKapitalgesellschaft, type AssetWithdrawal, type Rechtsform } from "@haben/core";
import { eq } from "drizzle-orm";
import { db, schema, type Db, type Tx } from "../../db/index.ts";
import { kleinunternehmerHistory, lastDayOfMonth } from "../stammdaten/index.ts";

/*
 * Abgang einer Anlage als Entnahme ins Privatvermögen (#1970, docs/anlagen.md): Entnahmewert, Umsatzsteuer und Zeile 19
 * der EÜR aus dem Anlagenverzeichnis. Die Regeln stehen in @haben/core (afa-entnahme.ts). Wie bei der Privatnutzung bucht
 * das Journal die Entnahme erst mit der AfA des Jahres; Voranmeldung und EÜR nehmen sie bis dahin von hier.
 */

type AssetRow = typeof schema.assets.$inferSelect;

/** Entnahme im Jahr des Abgangs; die Umsatzsteuer nach dem Stand als Kleinunternehmer im Monat der Entnahme */
export function withdrawalForYear(asset: AssetRow, year: number, kleinunternehmer: (month: number) => boolean) {
  if (!asset.disposalWithdrawal || !asset.disposalDate || Number(asset.disposalDate.slice(0, 4)) !== year) return null;
  const month = Number(asset.disposalDate.slice(5, 7));
  return {
    date: asset.disposalDate,
    month,
    value: asset.disposalWithdrawal.value,
    umsatz: entnahmeUmsatz(asset.disposalWithdrawal, kleinunternehmer(month)),
  };
}

/** Warum die Entnahme so nicht geht, oder null. In GmbH und UG wäre sie eine verdeckte Gewinnausschüttung. */
export function withdrawalProblem(asset: { disposalDate: string | null; disposalWithdrawal: AssetWithdrawal | null }, rechtsform: Rechtsform): string | null {
  if (!asset.disposalWithdrawal) return null;
  if (isKapitalgesellschaft(rechtsform)) return "Die Entnahme einer Anlage gibt es nur im Einzelunternehmen.";
  if (!asset.disposalDate) return "Eine Entnahme braucht ein Abgangsdatum.";
  return null;
}

export const sameWithdrawal = (a: AssetWithdrawal | null, b: AssetWithdrawal | null): boolean =>
  a === null || b === null ? a === b : a.value === b.value && a.inputVat === b.inputVat;

/** Entnommene Anlagen eines Monats mit Umsatzsteuer: Kz 81 (regelbesteuert) bzw. Kz 48 (Kleinunternehmer), ohne nicht steuerbare */
export async function assetWithdrawalsForMonth(year: number, month: number, q: Db | Tx = db) {
  const assets = await q.select().from(schema.assets);
  const history = await kleinunternehmerHistory(q);
  const kleinunternehmer = (m: number) => history(lastDayOfMonth(year, m));
  return assets.flatMap((asset) => {
    const withdrawal = withdrawalForYear(asset, year, kleinunternehmer);
    if (!withdrawal || withdrawal.month !== month || withdrawal.umsatz.steuer === "nichtSteuerbar" || withdrawal.umsatz.base === 0) return [];
    return [{ assetId: asset.id, name: asset.name, date: withdrawal.date, ...withdrawal.umsatz }];
  });
}

/** Vorbelegung „Beim Kauf Vorsteuer gezogen“: Der Anschaffungsbeleg hat ganz oder teilweise Vorsteuer abgezogen */
export async function documentInputVat(documentId: string, q: Db | Tx = db): Promise<boolean> {
  const [doc] = await q
    .select({ tax: schema.documents.tax, abzug: schema.documents.vorsteuerAbzug, anteil: schema.documents.vorsteuerAnteil })
    .from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  return Boolean(doc?.abzug && doc.tax > 0 && doc.anteil !== 0);
}
