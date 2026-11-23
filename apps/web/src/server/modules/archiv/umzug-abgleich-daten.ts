import { accountingTypeUnclear, taxTypeOf } from "../auswertungen/index.ts";
import { effectivePayment } from "../auswertungen/index.ts";
import { effectiveAmount, effectiveDirection, effectiveTaxes, effectiveType } from "../auswertungen/index.ts";
import { eq, sql } from "drizzle-orm";
import { ohneJit } from "../../db/ohne-jit.ts";
import { sevdeskPositionAccounts } from "./sevdesk-kategorie.ts";
import { db, schema } from "../../db/index.ts";
import { customTaxSetId } from "./sevdesk-steuerarten.ts";
import { latestFileStateSql } from "./dateistand.ts";
import { WITHOUT_RECEIPT } from "./umzug-belege.ts";
import { ohneSevdeskExportBelegbildSql } from "./sevdesk-export-abgleich.ts";

const TAX_TYPE = sql<string | null>`${taxTypeOf("lexoffice_vouchers")}`;
const TAX_SUB_TYPE = sql<string | null>`lexoffice_vouchers.raw->'taxConditions'->>'taxSubType'`;

export async function reconciliationVoucherRows() {
  return ohneJit((tx) =>
    tx
      .select({
        source: schema.lexofficeVouchers.source,
        lexofficeId: schema.lexofficeVouchers.lexofficeId,
        direction: effectiveDirection("lexoffice_vouchers"),
        type: effectiveType("lexoffice_vouchers"),
        number: schema.lexofficeVouchers.number,
        date: schema.lexofficeVouchers.date,
        status: schema.lexofficeVouchers.status,
        net: effectiveAmount("lexoffice_vouchers", "net"),
        tax: effectiveAmount("lexoffice_vouchers", "tax"),
        gross: effectiveAmount("lexoffice_vouchers", "gross"),
        taxes: effectiveTaxes("lexoffice_vouchers"),
        categories: schema.lexofficeVouchers.categories,
        payment: effectivePayment("lexoffice_vouchers"),
        payDate: sql<string | null>`lexoffice_vouchers.raw->>'payDate'`,
        taxType: TAX_TYPE,
        taxSubType: TAX_SUB_TYPE,
        taxSetId: customTaxSetId("lexoffice_vouchers"),
        ohneBeleg: WITHOUT_RECEIPT,
        fileState: latestFileStateSql("lexoffice_vouchers"),
        ohneBelegbild: ohneSevdeskExportBelegbildSql("lexoffice_vouchers"),
        privat: sql<boolean>`coalesce((lexoffice_vouchers.raw->>'privat')::boolean, false)`,
        bbNeutral: sql<boolean>`coalesce((lexoffice_vouchers.raw->>'neutral')::boolean, false)`,
        accountingTypeUnclear: accountingTypeUnclear("lexoffice_vouchers"),
        positionAccounts: sevdeskPositionAccounts("lexoffice_vouchers"),
        // Spalte ausdrücklich qualifizieren: drizzle schreibt sonst nur "id", und das träfe f.id
        files: sql<number>`(select count(*)::int from lexoffice_voucher_files f where f.voucher_id = lexoffice_vouchers.id)`,
      })
      .from(schema.lexofficeVouchers),
  );
}

export async function reconciliationDatevRows() {
  return db
    .select({
      date: schema.datevBookings.date,
      amount: schema.datevBookings.amount,
      side: schema.datevBookings.side,
      account: schema.datevBookings.account,
      contraAccount: schema.datevBookings.contraAccount,
      buKey: schema.datevBookings.buKey,
      accountLength: sql<number | null>`(${schema.archiveFiles.meta} -> 'header' ->> 'accountLength')::int`,
      fileId: schema.datevBookings.fileId,
    })
    .from(schema.datevBookings)
    .leftJoin(schema.archiveFiles, eq(schema.archiveFiles.id, schema.datevBookings.fileId));
}

export async function reconciliationSourceFiles() {
  // DATEV-Stapel der BuchhaltungsButler-Importe, auch wenn die Datei schon vorher im Archiv lag
  const bbImports = await db
    .select({ progress: schema.lexofficeImports.progress })
    .from(schema.lexofficeImports)
    .where(eq(schema.lexofficeImports.source, "buchhaltungsbutler"));
  const bbFileIds = new Set(bbImports.flatMap((i) => i.progress.datevFileIds ?? []));
  // Ebenso die Stapel aus der Export-ZIP von sevDesk; in Jahren mit Belegen aus der API zählen diese (keine Doppelung)
  const sevExportImports = await db
    .select({ progress: schema.lexofficeImports.progress })
    .from(schema.lexofficeImports)
    .where(eq(schema.lexofficeImports.source, "sevdesk-export"));
  const sevExportFileIds = new Set(sevExportImports.flatMap((i) => i.progress.sevdeskExport?.stackFileIds ?? []));

  return { bbFileIds, sevExportFileIds };
}
