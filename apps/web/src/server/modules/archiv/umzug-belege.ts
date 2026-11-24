import { accountingTypeKinds, accountingTypeUnclear } from "../auswertungen/index.ts";
import { ohneSevdeskExportBelegbildSql } from "./sevdesk-export-abgleich.ts";
import { truncatedNumberMatches } from "./datev-belegnummer.ts";
import { effectivePayment, paymentHistoryIssue, visiblePayment } from "../auswertungen/index.ts";
import { accountingTypeDecidable, accountingTypeIssue } from "./sevdesk-kontoart.ts";
import { effectiveAmount, effectiveContactName, effectiveDirection, effectiveTaxes, effectiveType } from "../auswertungen/index.ts";
import { eq, sql } from "drizzle-orm";
import { loadSevdeskAccountCategories, sevdeskCategories, sevdeskPositionAccounts } from "./sevdesk-kategorie.ts";
import { db, schema } from "../../db/index.ts";
import type { LegacyFileState, LegacySource } from "../../db/schema.ts";
import { legacyDunningsFor } from "./mahnungen-archiv.ts";
import { latestFileStateSql, legacyFileStatus, legacyVoucherFileState, OPEN_FILE_STATUSES } from "./dateistand.ts";

/** Buchung ohne Beleg aus der Sicherung der Web-Oberfläche: hat keine Datei und braucht keine */
export const WITHOUT_RECEIPT = sql<boolean>`coalesce((lexoffice_vouchers.raw->>'ohneBeleg')::boolean, false)`;

export async function listLegacyVouchers(filter: { year: number; direction: "alle" | "einnahme" | "ausgabe"; search: string; ohneDatei: boolean }) {
  const term = filter.search.trim() ? `%${filter.search.trim()}%` : null;
  const hatDatei = sql`exists (select 1 from lexoffice_voucher_files f where f.voucher_id = v.id)`;
  const rows = await db.execute<{
    id: string;
    source: LegacySource;
    type: string;
    direction: "einnahme" | "ausgabe";
    number: string;
    date: string;
    status: string;
    contact_name: string;
    net: number;
    tax: number;
    gross: number;
    files: number;
    file_state: LegacyFileState | null;
    ohne_beleg: boolean;
    accounting_type_unclear: boolean;
  }>(sql`
    select v.id, v.source, ${effectiveType("v")} as type, ${effectiveDirection("v")} as direction, v.number, v.date::text as date, v.status, ${effectiveContactName("v")} as contact_name, ${effectiveAmount("v", "net")} as net, ${effectiveAmount("v", "tax")} as tax, ${effectiveAmount("v", "gross")} as gross,
      (select count(*)::int from lexoffice_voucher_files f where f.voucher_id = v.id) as files, ${latestFileStateSql("v")} as file_state,
      coalesce((v.raw->>'ohneBeleg')::boolean, false) as ohne_beleg, ${accountingTypeUnclear("v")} as accounting_type_unclear
    from lexoffice_vouchers v
    where v.date between ${`${filter.year}-01-01`} and ${`${filter.year}-12-31`}
      ${filter.direction === "alle" ? sql`` : sql`and ${effectiveDirection("v")} = ${filter.direction}`}
      ${term ? sql`and (v.number ilike ${term} or ${effectiveContactName("v")} ilike ${term} or v.remark ilike ${term})` : sql``}
      ${
        // Vorauswahl vor dem Limit; welcher Stand offen ist, entscheidet legacyFileStatus unten
        filter.ohneDatei
          ? sql`and not coalesce((v.raw->>'ohneBeleg')::boolean, false) and (
              (not ${hatDatei} and not ${ohneSevdeskExportBelegbildSql("v")})
              or (${hatDatei} and ${latestFileStateSql("v")} in ('abruf_fehlgeschlagen', 'anhang_fehlt'))
            )`
          : sql``
      }
    order by v.date, v.number
    limit 1000`);
  // Ohne Datei: alles, was noch Arbeit braucht (#345), nicht die bestätigt dateilosen und nicht Buchungen ohne Beleg
  const status = (r: (typeof rows)[number]) => legacyFileStatus(r.file_state, Number(r.files), r.ohne_beleg);
  return [...rows]
    .filter((r) => !filter.ohneDatei || OPEN_FILE_STATUSES.has(status(r)))
    .map((r) => ({
      id: r.id,
      source: r.source,
      type: r.type,
      direction: r.direction,
      number: r.number,
      date: r.date,
      status: r.status,
      contactName: r.contact_name,
      net: Number(r.net),
      tax: Number(r.tax),
      gross: Number(r.gross),
      files: Number(r.files),
      fileStatus: status(r),
      accountingTypeUnclear: r.accounting_type_unclear,
    }));
}

export async function legacyVoucherDetail(id: string) {
  const [voucher] = await db
    .select({
      id: schema.lexofficeVouchers.id,
      lexofficeId: schema.lexofficeVouchers.lexofficeId,
      source: schema.lexofficeVouchers.source,
      sourceName: sql<string | null>`case when ${schema.lexofficeVouchers.source} = 'import' then ${schema.lexofficeVouchers.raw}->>'sourceName' else null end`,
      externalId: sql<string>`case when ${schema.lexofficeVouchers.source} = 'import' then ${schema.lexofficeVouchers.raw}->>'externalId' else ${schema.lexofficeVouchers.lexofficeId} end`,
      type: effectiveType("lexoffice_vouchers"),
      direction: effectiveDirection("lexoffice_vouchers"),
      number: schema.lexofficeVouchers.number,
      date: schema.lexofficeVouchers.date,
      dueDate: schema.lexofficeVouchers.dueDate,
      serviceFrom: schema.lexofficeVouchers.serviceFrom,
      serviceTo: schema.lexofficeVouchers.serviceTo,
      status: schema.lexofficeVouchers.status,
      contactId: schema.lexofficeVouchers.contactId,
      contactName: effectiveContactName("lexoffice_vouchers"),
      currency: schema.lexofficeVouchers.currency,
      net: effectiveAmount("lexoffice_vouchers", "net"),
      tax: effectiveAmount("lexoffice_vouchers", "tax"),
      gross: effectiveAmount("lexoffice_vouchers", "gross"),
      taxes: effectiveTaxes("lexoffice_vouchers"),
      categories: schema.lexofficeVouchers.categories,
      payment: effectivePayment("lexoffice_vouchers"),
      payDate: sql<string | null>`${schema.lexofficeVouchers.raw}->>'payDate'`,
      remark: schema.lexofficeVouchers.remark,
      createdAt: schema.lexofficeVouchers.createdAt,
      accountingType: accountingTypeKinds("lexoffice_vouchers"),
      ohneBeleg: WITHOUT_RECEIPT,
      rawGuid: sql<string | null>`${schema.lexofficeVouchers.raw}->>'guid'`,
      rawQuelle: sql<string | null>`${schema.lexofficeVouchers.raw}->>'quelle'`,
      rawDocumentPresent: sql<boolean | null>`(${schema.lexofficeVouchers.raw}->>'documentPresent')::boolean`,
      positionAccounts: sevdeskPositionAccounts("lexoffice_vouchers"),
    })
    .from(schema.lexofficeVouchers)
    .where(eq(schema.lexofficeVouchers.id, id));
  if (!voucher) return null;
  const files = await db
    .select({
      id: schema.lexofficeVoucherFiles.id,
      role: schema.lexofficeVoucherFiles.role,
      filename: schema.lexofficeVoucherFiles.filename,
      mimeType: schema.lexofficeVoucherFiles.mimeType,
      size: schema.lexofficeVoucherFiles.size,
      sha256: schema.lexofficeVoucherFiles.sha256,
      lexofficeFileId: schema.lexofficeVoucherFiles.lexofficeFileId,
    })
    .from(schema.lexofficeVoucherFiles)
    .where(eq(schema.lexofficeVoucherFiles.voucherId, id))
    .orderBy(schema.lexofficeVoucherFiles.createdAt, schema.lexofficeVoucherFiles.id);
  // Mahnstufen der Rechnung aus der Quelle; nur Archiv, ohne Wirkung auf Betrag und Zahlungsstand
  const dunnings = voucher.direction === "einnahme" ? await legacyDunningsFor([voucher.lexofficeId]) : [];
  const { positionAccounts, rawQuelle, ...shown } = voucher;
  const fileState = await legacyVoucherFileState(shown, files.length, rawQuelle);
  const categories = positionAccounts ? sevdeskCategories(voucher.categories, positionAccounts, await loadSevdeskAccountCategories()) : voucher.categories;
  // Frühere WISO-Importe setzten das Zahlungsdatum als Leistung, obwohl die Quelle sie nicht belegt (#565).
  // Nur lesend korrigieren; die unveränderliche Archivzeile bleibt erhalten. Quelle: https://github.com/Speicherstadt/haben/issues/565
  return {
    voucher: {
      ...shown,
      categories,
      serviceFrom: voucher.source === "wiso" ? null : voucher.serviceFrom,
      serviceTo: voucher.source === "wiso" ? null : voucher.serviceTo,
      payment: visiblePayment(voucher),
      paymentHistoryIssue: paymentHistoryIssue(voucher),
      accountingTypeIssue: accountingTypeIssue(voucher.accountingType),
      accountingTypeDecidable: accountingTypeDecidable(voucher.accountingType),
    },
    // Von einem späteren Abruf angehängt: Zeitpunkt des Stands „nachgeladen“ zu Rolle und Quell-ID der Datei
    files: files.map((f) => ({
      ...f,
      reloadedAt:
        fileState.history.find((s) => s.state === "nachgeladen" && s.role === f.role && s.sourceFileId === (f.role === "anhang" ? f.lexofficeFileId : null))
          ?.createdAt ?? null,
    })),
    dunnings,
    fileState,
  };
}

export async function legacyVoucherFile(fileId: string) {
  const [file] = await db.select().from(schema.lexofficeVoucherFiles).where(eq(schema.lexofficeVoucherFiles.id, fileId));
  return file ?? null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ein Beleg mit der gespeicherten API-Antwort, gesucht nach ID in Haben, ID in Lexoffice bzw. sevDesk oder Belegnummer
 * (Leerzeichen und Groß-/Kleinschreibung egal). Bei einer Nummer können es mehrere sein.
 */
export async function findLegacyVouchers(ref: string) {
  const value = ref.trim();
  if (!value) return [];
  const rows = await db
    .select({ id: schema.lexofficeVouchers.id, raw: schema.lexofficeVouchers.raw })
    .from(schema.lexofficeVouchers)
    .where(
      // Auch eine Belegnummer kann wie eine UUID aussehen; sevDesk-Kennungen wie "invoice/101" sind keine
      sql`${schema.lexofficeVouchers.lexofficeId} = ${value}
        or lower(regexp_replace(${schema.lexofficeVouchers.number}, '\\s+', '', 'g')) = lower(regexp_replace(${value}, '\\s+', '', 'g'))
        or ${truncatedNumberMatches("lexoffice_vouchers", sql`${value}`)}
        ${UUID.test(value) ? sql`or ${schema.lexofficeVouchers.id} = ${value}::uuid` : sql``}`,
    )
    .limit(10);
  const result = [];
  for (const row of rows) {
    const detail = await legacyVoucherDetail(row.id);
    if (detail) result.push({ ...detail, raw: row.raw });
  }
  return result;
}
