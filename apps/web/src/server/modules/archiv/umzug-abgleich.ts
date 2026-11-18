import { bookingsCheckDetail, datevBookingCounts, type DatevBookingCounts } from "./datev-abgleich.ts";
import { SEVDESK_EXPORT_IST_CHECK, sevdeskExportIstIssue, sevdeskExportYear, voucherSourceChecks, withoutExportImage } from "./sevdesk-export-abgleich.ts";
import { unclearFrom } from "../auswertungen/index.ts";
import { accountingTypeChecks, ACCOUNTING_TYPE_VAT_ISSUE, unclearAccountingTypes } from "./sevdesk-kontoart.ts";
import { datevYearSums } from "@haben/import";
import { legacyNeutralSums, legacyVatByMonth, type Versteuerung } from "@haben/core";
import { eq } from "drizzle-orm";
import { loadCompany } from "../stammdaten/index.ts";
import { loadSevdeskAccountCategories, sevdeskCategories } from "./sevdesk-kategorie.ts";
import { db, schema } from "../../db/index.ts";
import type { LegacySource } from "../../db/schema.ts";
import { fastbillPartlyCanceledByYear, fastbillPartlyCanceledChecks, fastbillWaitingChecks } from "./fastbill-abgleich.ts";
import { fastbillWaitingByYear } from "./fastbill-belege.ts";
import { legacyTaxSetFields, vatFieldsOf } from "./sevdesk-steuerarten.ts";
import { fileCheck, fileCounts, legacyFileStatus, OPEN_FILE_STATUSES } from "./dateistand.ts";
import { latestImportFor } from "./umzug-lauf.ts";
import { legacyPayments, neutralKindOf } from "./umzug-umsatzsteuer.ts";
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
  // Ohne Einzelzahlungen können selbst bereits vollständig bezahlte sevDesk-Rechnungen mehrere Monate betreffen.
  // Gesperrt ist jedes Jahr, in das eine solche Zahlung fallen kann: bis zum Ausgleich, ohne Ausgleichsdatum alle.
  const paymentIssueOf = (year: number) => {
    if (versteuerung !== "ist") return null;
    if (businessRows.some((v) => v.direction === "einnahme" && unclearFrom(v, String(year)))) {
      return "sevDesk-Zahlungshistorie unvollständig: Der Ist-Monatsabgleich ist bis zur Klärung der Einzelzahlungen gesperrt.";
    }
    return null;
  };
  const unclearAccountsIn = (year: number) => unclearAccountingTypes(businessRows, year, (v) => (versteuerung === "ist" ? legacyPayments(v) : []));
  const exportIstIssueOf = (year: number) => sevdeskExportIstIssue(versteuerung, classified, year);
  const vatIssueOf = (year: number) =>
    [paymentIssueOf(year), unclearAccountsIn(year) ? ACCOUNTING_TYPE_VAT_ISSUE : null, exportIstIssueOf(year)].filter(Boolean).join(" ") || null;

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
    versteuerung,
    voucherRows,
    classified,
    figures,
    businessRows,
    paymentIssueOf,
    unclearAccountsIn,
    exportIstIssueOf,
    vatIssueOf,
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

type ReconciliationData = Awaited<ReturnType<typeof reconciliationData>>;

function reconciliationChecks(
  year: number,
  data: ReconciliationData,
  details: {
    yearRows: ReconciliationData["classified"];
    vouchers: ReconciliationData["businessRows"];
    withoutReceipt: number;
    bookings: DatevBookingCounts | undefined;
    fileStatuses: ReturnType<typeof legacyFileStatus>[];
    sevdeskExport: ReturnType<typeof sevdeskExportYear>;
  },
) {
  const { yearRows, vouchers, withoutReceipt, bookings, fileStatuses, sevdeskExport } = details;
  const { voucherRows, paymentIssueOf, unclearAccountsIn, exportIstIssueOf, files, vatProtocols, fastbillWaiting, fastbillPartlyCanceled } = data;
  const kinds = (kind: string) => files.filter((f) => f.year === year && f.kind === kind).length;
  const elster = kinds("elster") + vatProtocols.filter((p) => p.year === year).length;
  // Accountable exportiert keinen IDEA-Export. Den trotzdem zu verlangen, macht "vollständig"
  // strukturell unerreichbar — der Punkt entfällt bei dieser Herkunft.
  const nurAccountable = voucherRows.length > 0 && voucherRows.every((v) => v.source === "accountable");
  const checks: ReconciliationCheck[] = [
    ...(paymentIssueOf(year) ? [{ ok: false, label: "Zahlungshistorie vollständig", detail: paymentIssueOf(year)! }] : []),
    ...(exportIstIssueOf(year) ? [SEVDESK_EXPORT_IST_CHECK] : []),
    ...accountingTypeChecks(unclearAccountsIn(year)),
    ...fastbillWaitingChecks(fastbillWaiting.get(year)),
    ...fastbillPartlyCanceledChecks(fastbillPartlyCanceled.get(year)),
    ...voucherSourceChecks({ sevdeskExport, apiVouchers: vouchers.length, yearRows, withoutReceipt }),
    fileCheck(fileStatuses),
    {
      ok: Boolean(bookings && bookings.total > 0),
      label: "DATEV-Buchungsstapel übernommen",
      detail: bookings ? `${bookings.total} Buchungen` : "fehlt",
    },
    {
      ok: Boolean(bookings) && bookings!.unmatched === 0,
      // Buchungen ohne Belegnummer (Umbuchungen, Privates) brauchen nicht immer einen Beleg; sie stehen nur im Hinweis.
      // Ein Belegfeld ohne Ziffer ist keine Nummer, sondern etwa der Name eines Zahlungsdienstleisters (#1355).
      label: "Jede Buchung mit Belegnummer findet ihren Beleg",
      detail: bookings ? bookingsCheckDetail(bookings) : "–",
    },
    ...(nurAccountable ? [] : [{ ok: kinds("idea") > 0, label: "IDEA-Export archiviert", detail: kinds("idea") > 0 ? "liegt vor" : "fehlt" }]),
    {
      ok: elster > 0,
      label: "ELSTER-Protokolle archiviert",
      detail: elster > 0 ? `${elster} Dateien` : "fehlen",
    },
    {
      ok: kinds("kontoauszug") > 0,
      label: "Kontoauszüge archiviert",
      detail: kinds("kontoauszug") > 0 ? `${kinds("kontoauszug")} Dateien` : "fehlen",
    },
  ];
  return checks;
}

function reconciliationVat(year: number, data: ReconciliationData, vatIssue: string | null) {
  const { businessRows, versteuerung, taxSets } = data;
  // Ist-Versteuerung: Zahlungen aus dem Zahlungsstatus; sonst Belegdatum

  return vatIssue
    ? []
    : legacyVatByMonth(
        businessRows
          .filter((v) => (versteuerung === "ist" ? true : v.date.startsWith(`${year}-`)))
          .map((v) => ({
            direction: v.direction,
            date: v.date,
            net: v.net,
            tax: v.tax,
            gross: v.gross,
            taxes: v.taxes,
            payments: legacyPayments(v),
            taxType: v.taxType,
            taxSubType: v.taxSubType,
            vatFields: vatFieldsOf(v.taxSetId, taxSets, v.taxType),
          })),
        versteuerung,
      ).filter((m) => m.month.startsWith(`${year}-`));
}

function reconciliationInvoices(vouchers: ReconciliationData["businessRows"], yearRows: ReconciliationData["classified"]) {
  // Auch die Rechnungen aus BuchhaltungsButler: Der Nummernkreis läuft in Haben weiter (§ 14 Abs. 4 Satz 1 Nr. 4 UStG)
  return (
    [...vouchers, ...yearRows.filter((v) => v.source === "buchhaltungsbutler" && !v.bbNeutral)]
      // Stornorechnung und Abschlagsrechnung von sevDesk belegen denselben Nummernkreis wie die Rechnungen (#472)
      .filter(
        (v) =>
          v.number &&
          (v.type === "invoice" ||
            (v.source === "sevdesk" && (v.type === "downpaymentinvoice" || (v.type === "creditnote" && v.lexofficeId.startsWith("invoice/"))))),
      )
      .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number, "de", { numeric: true }))
  );
}

function reconciliationYear(year: number, data: ReconciliationData) {
  const { company, voucherRows, classified, figures, businessRows, vatIssueOf, bookingRows, datevRows, bbFileIds, sevExportFileIds } = data;
  const vouchers = businessRows.filter((v) => v.date.startsWith(`${year}-`));
  // Alle Belege des Jahres, auch neutrale: Auch ein Körperschaftsteuerbescheid braucht seine Datei
  const yearRows = classified.filter((v) => v.date.startsWith(`${year}-`));
  const withoutReceipt = voucherRows.filter((v) => v.ohneBeleg && v.date.startsWith(`${year}-`)).length;
  const yearDatev = datevRows.filter((b) => b.date.startsWith(`${year}-`));
  // Accountable legt in den Belegen nur Ausgaben ab; die Erlöse stehen ausschließlich im
  // Buchungsstapel. Ohne diese Ausnahme blieben die Einnahmen bei 0, obwohl die Buchung da ist.
  const yearEinnahmeBelege = vouchers.some((v) => v.direction === "einnahme" && v.date.startsWith(`${year}-`));
  const fromDatev = (vouchers.length === 0 || !yearEinnahmeBelege) && yearDatev.length > 0 ? datevYearSums(yearDatev, company.kontenrahmen) : null;
  // Mischjahr (Wechsel unter dem Jahr): Belege aus Lexoffice oder sevDesk, dazu der Teil aus dem Stapel von BuchhaltungsButler
  // oder aus der Export-ZIP von sevDesk
  const sevApiYear = yearRows.some((v) => v.source === "sevdesk");
  const bbDatev = yearDatev.filter((b) => b.fileId !== null && (bbFileIds.has(b.fileId) || (!sevApiYear && sevExportFileIds.has(b.fileId))));
  const bbPart = !fromDatev && bbDatev.length > 0 ? datevYearSums(bbDatev, company.kontenrahmen) : null;
  const sum = (direction: "einnahme" | "ausgabe") => {
    const pick = (sums: NonNullable<typeof fromDatev>) => (direction === "einnahme" ? sums.einnahmen : sums.ausgaben);
    if (fromDatev) {
      const { net, tax } = pick(fromDatev);
      return { count: 0, net, tax, gross: net + tax };
    }
    const rows = vouchers.filter((v) => v.direction === direction);
    const bb = bbPart ? pick(bbPart) : { net: 0, tax: 0 };
    return {
      count: rows.length,
      net: rows.reduce((s, r) => s + r.net, 0) + bb.net,
      tax: rows.reduce((s, r) => s + r.tax, 0) + bb.tax,
      gross: rows.reduce((s, r) => s + r.gross, 0) + bb.net + bb.tax,
    };
  };
  // Dateistand (#345): bestätigt dateilose Belege zählen getrennt und blockieren nicht. Ein Exportbeleg ohne Belegbild
  // braucht keine Datei; er steht mit eigener Zahl im Abgleich (#1106)
  const fileStatuses = yearRows.filter((v) => !withoutExportImage(v)).map((v) => legacyFileStatus(v.fileState, Number(v.files), v.ohneBeleg));
  const withoutFile = fileStatuses.filter((f) => OPEN_FILE_STATUSES.has(f) && f !== "anhang_fehlt").length;
  const sevdeskExport = sevdeskExportYear(yearRows);
  const unchecked = vouchers.filter((v) => v.status === "unchecked").length;
  const bookings = bookingRows.get(year);
  const vatIssue = vatIssueOf(year);
  const vat = reconciliationVat(year, data, vatIssue);
  // Einnahmen je Steuerart, damit Sonderfälle (EU, Drittland, § 13b) beim Vergleich auffallen
  const taxTypes = new Map<string, number>();
  for (const v of vouchers) {
    if (v.direction !== "einnahme") continue;
    const key = [v.taxType ?? "net", v.taxSubType].filter(Boolean).join("/");
    taxTypes.set(key, (taxTypes.get(key) ?? 0) + 1);
  }
  const invoices = reconciliationInvoices(vouchers, yearRows);

  const checks = reconciliationChecks(year, data, { yearRows, vouchers, withoutReceipt, bookings, fileStatuses, sevdeskExport });
  return {
    year,
    einnahmen: sum("einnahme"),
    ausgaben: sum("ausgabe"),
    /** Weder Einnahme noch Ausgabe, je Art: zum Vergleich sichtbar statt still weggelassen */
    neutral: legacyNeutralSums(
      figures.flatMap((v) => (v.neutral && v.date.startsWith(`${year}-`) ? [{ kind: v.neutral, direction: v.direction, gross: v.gross }] : [])),
    ),
    /** "datev": keine Belege per API, die Summen stammen aus dem Buchungsstapel; "gemischt": Belege und BB-Stapel */
    sumsFrom: fromDatev ? ("datev" as const) : bbPart ? ("gemischt" as const) : ("belege" as const),
    /** Belege aus der Export-ZIP von sevDesk je Zustand; null ohne solche Belege */
    sevdeskExport,
    withoutFile,
    files: fileCounts(fileStatuses),
    unchecked,
    bookings: bookings ? { total: bookings.total, unmatched: bookings.unmatched, withoutNumber: bookings.withoutNumber } : null,
    vat,
    vatIssue,
    taxTypes: [...taxTypes].map(([taxType, count]) => ({ taxType, count })).sort((a, b) => b.count - a.count),
    lastInvoiceNumber: invoices.at(-1)?.number ?? null,
    checks,
    ready: checks.every((c) => c.ok),
  };
}

/** Abgleich je Geschäftsjahr: Was liegt vor, was fehlt noch vor der Kündigung? */
export async function reconciliation() {
  const data = await reconciliationData();
  const years = [...data.years].sort((a, b) => b - a).map((year) => reconciliationYear(year, data));
  return { versteuerung: data.versteuerung, rechtsform: data.company.rechtsform, years, lastImport: data.lastImport };
}
