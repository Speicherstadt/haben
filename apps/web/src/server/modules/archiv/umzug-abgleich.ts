import { datevBookingCounts } from "./datev-abgleich.ts";
import type { Versteuerung } from "@haben/core";
import { eq } from "drizzle-orm";
import { loadCompany } from "../stammdaten/index.ts";
import { loadSevdeskAccountCategories, sevdeskCategories } from "./sevdesk-kategorie.ts";
import { db, schema } from "../../db/index.ts";
import type { LegacySource } from "../../db/schema.ts";
import { fastbillPartlyCanceledByYear } from "./fastbill-abgleich.ts";
import { fastbillWaitingByYear } from "./fastbill-belege.ts";
import { abgleichJahr } from "./umzug-abgleich-jahr.ts";
import { legacyTaxSetFields } from "./sevdesk-steuerarten.ts";
import { latestImportFor } from "./umzug-lauf.ts";
import { neutralKindOf } from "./umzug-umsatzsteuer.ts";
import { reconciliationVoucherRows, reconciliationDatevRows, reconciliationSourceFiles } from "./umzug-abgleich-daten.ts";

/** Belege nur als Archiv: Summen und Steuer kommen aus ihrem DATEV-Buchungsstapel. */
const ARCHIVE_ONLY_SOURCES = new Set<LegacySource>(["buchhaltungsbutler", "sevdesk-export"]);

export type ReconciliationCheck = { ok: boolean; label: string; detail: string };

async function reconciliationData() {
  const company = await loadCompany();
  const versteuerung: Versteuerung = company.versteuerung;

  // Die geschätzten Kosten wachsen mit dem Quadrat der Belege; mit JIT dauerte schon das Kompilieren Sekunden (ohne-jit.ts)
  const voucherRows = await reconciliationVoucherRows();
  // Archiviert, aber weder Einnahme noch Ausgabe: im Einzelunternehmen Privates und Geldtransit, in GmbH und UG
  // Gesellschafter, Kapital, Darlehen und Steuern vom Einkommen; sie stehen je Jahr getrennt (neutral)
  const known = await loadSevdeskAccountCategories();
  const classified = voucherRows.map((v) => {
    const categories = sevdeskCategories(v.categories, v.positionAccounts, known);
    return { ...v, categories, neutral: neutralKindOf({ ...v, categories }, company.rechtsform) ?? (v.bbNeutral ? ("geldtransit" as const) : null) };
  });
  // BuchhaltungsButler-Belege nur als Archiv (Suche, PDF): Einnahme, Ausgabe oder neutral ließe sich aus den Konten nur
  // schätzen. Summen und Steuer kommen für diese Jahre aus dem DATEV-Buchungsstapel desselben Exports. Ebenso die Belege aus
  // der Export-ZIP von sevDesk: Darlehen, Privates, Steuern und Zinsen stehen dort als Beleg ohne Kategorie (#1105).
  const figures = classified.filter((v) => !ARCHIVE_ONLY_SOURCES.has(v.source));
  const businessRows = figures.filter((v) => !v.neutral);
  const bookingRows = await datevBookingCounts(company.kontenrahmen);
  const files = await db.select({ kind: schema.archiveFiles.kind, year: schema.archiveFiles.year }).from(schema.archiveFiles);
  // Protokolle der aus sevDesk übernommenen Voranmeldungen zählen wie abgelegte ELSTER-Protokolle (#472)
  const vatProtocols = await db
    .select({ year: schema.legacyVatReports.year })
    .from(schema.legacyVatReportFiles)
    .innerJoin(schema.legacyVatReports, eq(schema.legacyVatReportFiles.vatReportId, schema.legacyVatReports.id));
  const lastImport = await latestImportFor("lexoffice");
  // Eigene Steuerarten aus sevDesk: Kennzahlen aus dem jüngsten Abruf, auch für früher abgerufene Belege
  const taxSets = await legacyTaxSetFields();
  // Für Jahre ohne Belege per API (Umzug nur über DATEV): Summen aus dem Buchungsstapel
  const datevRows = await reconciliationDatevRows();

  const { bbFileIds, sevExportFileIds } = await reconciliationSourceFiles();

  // Ausgaben aus FastBill, die noch auf ihren Beleg warten, liegen nicht in lexoffice_vouchers: sonst sähe ein Jahr vollständig aus
  const fastbillWaiting = await fastbillWaitingByYear();
  const fastbillPartlyCanceled = await fastbillPartlyCanceledByYear();
  const years = new Set<number>(fastbillWaiting.keys());
  for (const v of voucherRows) years.add(Number(v.date.slice(0, 4)));
  for (const year of bookingRows.keys()) years.add(year);
  for (const f of files) if (f.year) years.add(f.year);
  // Jahre mit aus sevDesk übernommenen Voranmeldungen, auch ohne Belege und ohne Protokoll (#472)
  for (const r of await db.selectDistinct({ year: schema.legacyVatReports.year }).from(schema.legacyVatReports)) years.add(r.year);

  return {
    company,
    kontenrahmen: company.kontenrahmen,
    versteuerung,
    voucherRows,
    classified,
    figures,
    businessRows,
    bookingRows,
    files,
    vatProtocols,
    lastImport,
    taxSets,
    datevRows,
    bbFileIds,
    sevExportFileIds,
    fastbillWaiting,
    fastbillPartlyCanceled,
    years,
  };
}

export type ReconciliationData = Awaited<ReturnType<typeof reconciliationData>>;

/** Abgleich je Geschäftsjahr: Was liegt vor, was fehlt noch vor der Kündigung? */
export async function reconciliation() {
  const data = await reconciliationData();
  const years = [...data.years].sort((a, b) => b - a).map((year) => abgleichJahr(year, data));
  return { versteuerung: data.versteuerung, rechtsform: data.company.rechtsform, years, lastImport: data.lastImport };
}
