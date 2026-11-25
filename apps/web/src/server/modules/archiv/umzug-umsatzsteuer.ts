import { accountingTypeKinds, type AccountingTypeKinds, taxTypeOf } from "../auswertungen/index.ts";
import { effectivePayment, paymentHistoryIssue, unclearFrom } from "../auswertungen/index.ts";
import { accountingTypeIssue } from "./sevdesk-kontoart.ts";
import { effectiveAmount, effectiveContactName, effectiveDirection, effectiveTaxes, effectiveType } from "../auswertungen/index.ts";
import { LEGACY_PAYMENT_TYPES, legacyNeutralKind, legacyNeutralSums, type LegacyNeutralKind, type LegacyNeutralSum, type Rechtsform } from "@haben/core";
import { eq, sql } from "drizzle-orm";
import { loadCompany } from "../stammdaten/index.ts";
import { ohneJit } from "../../db/ohne-jit.ts";
import { loadSevdeskAccountCategories, sevdeskCategories, sevdeskPositionAccounts } from "./sevdesk-kategorie.ts";
import { schema } from "../../db/index.ts";
import type { LegacyCategoryRow, LegacyPayment, LegacySource, LegacyTaxRow } from "../../db/schema.ts";
import { latestFileStateSql } from "./dateistand.ts";
import { LexofficeError } from "./umzug-gemeinsam.ts";

/**
 * Zahlungen, die bei Ist-Versteuerung als Entgelt zählen, mit dem Vorzeichen des Belegs (Gutschriften mindern die Umsätze).
 * Eine Zuordnung über 0 € ist keine Zahlung (#472).
 */
export function legacyPayments(v: { source: LegacySource; gross: number; status: string; payment: LegacyPayment | null }) {
  if (paymentHistoryIssue(v)) return [];
  return (v.payment?.items ?? [])
    .filter((p) => LEGACY_PAYMENT_TYPES.has(p.type) && p.date && p.amount !== 0)
    .map((p) => ({ date: p.date, amount: Math.sign(v.gross) * Math.abs(p.amount) }));
}

/** Weder Einnahme noch Ausgabe? Zur Laufzeit aus Kategorien und Rechtsform (legacyNeutralKind); die Rohdaten sind gesperrt */
export function neutralKindOf(v: { privat: boolean; categories: LegacyCategoryRow[]; tax: number }, rechtsform: Rechtsform): LegacyNeutralKind | null {
  return legacyNeutralKind({ privat: v.privat, categories: v.categories.map((c) => c.name), tax: Number(v.tax) }, rechtsform);
}

export interface LegacyVoucherForVat {
  id: string;
  type: string;
  direction: "einnahme" | "ausgabe";
  number: string;
  date: string;
  status: string;
  contactName: string;
  currency: string;
  net: number;
  tax: number;
  gross: number;
  taxes: LegacyTaxRow[];
  taxType: string | null;
  taxSubType: string | null;
  /** Zahlungen, die bei Ist-Versteuerung als Entgelt zählen */
  payments: { date: string; amount: number }[];
  paymentHistoryIssue: string | null;
  accountingTypeIssue: string | null;
  files: number;
}

/**
 * Belege mit Belegdatum im Zeitraum (JJJJ oder JJJJ-MM). Mit `withPayments` auch Einnahmen, die in diesem
 * Zeitraum bezahlt wurden: Das sind bei Ist-Versteuerung die Belege, aus denen die Monatswerte stammen.
 */
export async function legacyVouchersForPeriod(filter: {
  period: string;
  direction: "alle" | "einnahme" | "ausgabe";
  search: string;
  withPayments: boolean;
  limit: number;
  offset?: number;
}): Promise<{ total: number; vouchers: LegacyVoucherForVat[]; neutral: LegacyNeutralSum[] }> {
  if (filter.withPayments) {
    // Ausdrücke über alle sevDesk-Belege: mit JIT dauerte schon das Kompilieren Sekunden (ohne-jit.ts)
    const sevdeskRows = await ohneJit((tx) =>
      tx
        .select({
          source: schema.lexofficeVouchers.source,
          direction: effectiveDirection("lexoffice_vouchers"),
          gross: effectiveAmount("lexoffice_vouchers", "gross"),
          status: schema.lexofficeVouchers.status,
          payment: effectivePayment("lexoffice_vouchers"),
          payDate: sql<string | null>`${schema.lexofficeVouchers.raw}->>'payDate'`,
        })
        .from(schema.lexofficeVouchers)
        .where(eq(schema.lexofficeVouchers.source, "sevdesk")),
    );
    // Wie der Abgleich: Bei Ist-Versteuerung zählen die Zahlungen nur auf der Einnahmenseite
    if (sevdeskRows.some((v) => v.direction === "einnahme" && unclearFrom(v, filter.period))) {
      throw new LexofficeError(
        "sevDesk-Zahlungshistorie unvollständig: Eine zahlungsbezogene Zeitraumabfrage ist bis zur Klärung der Einzelzahlungen gesperrt.",
      );
    }
  }
  const like = `${filter.period}%`;
  const term = filter.search.trim() ? `%${filter.search.trim()}%` : null;
  // Mit Zahlungen prüft die Bedingung jeden Archivbeleg mit effectivePayment; mit JIT dauerte das Kompilieren Sekunden
  const rows = await ohneJit((tx) =>
    tx.execute<{
      id: string;
      source: LegacySource;
      type: string;
      direction: "einnahme" | "ausgabe";
      number: string;
      date: string;
      status: string;
      contact_name: string;
      currency: string;
      net: number;
      tax: number;
      gross: number;
      taxes: LegacyTaxRow[];
      payment: LegacyPayment | null;
      categories: LegacyCategoryRow[];
      privat: boolean;
      tax_type: string | null;
      tax_sub_type: string | null;
      files: number;
      accounting_type: AccountingTypeKinds | null;
      position_accounts: (string | null)[] | null;
    }>(sql`
    select v.id, v.source, ${effectiveType("v")} as type, ${effectiveDirection("v")} as direction, v.number, v.date::text as date, v.status, ${effectiveContactName("v")} as contact_name, v.currency, ${effectiveAmount("v", "net")} as net, ${effectiveAmount("v", "tax")} as tax, ${effectiveAmount("v", "gross")} as gross,
      ${effectiveTaxes("v")} as taxes, ${effectivePayment("v")} as payment, v.categories, coalesce((v.raw->>'privat')::boolean, false) as privat,
      ${taxTypeOf("v")} as tax_type,
      v.raw->'taxConditions'->>'taxSubType' as tax_sub_type,
      (select count(*)::int from lexoffice_voucher_files f where f.voucher_id = v.id) as files, ${latestFileStateSql("v")} as file_state,
      coalesce((v.raw->>'ohneBeleg')::boolean, false) as ohne_beleg, ${accountingTypeKinds("v")} as accounting_type,
      ${sevdeskPositionAccounts("v")} as position_accounts
    from lexoffice_vouchers v
    where (v.date::text like ${like}
      ${
        filter.withPayments
          ? sql`or (${effectiveDirection("v")} = 'einnahme' and exists (
              select 1 from jsonb_array_elements(coalesce((${effectivePayment("v")})->'items', '[]'::jsonb)) i
              where i->>'date' like ${like} and i->>'type' in (${sql.join(
                [...LEGACY_PAYMENT_TYPES].map((t) => sql`${t}`),
                sql`, `,
              )})))`
          : sql``
      })
      -- Belege aus BuchhaltungsButler und der Export-ZIP von sevDesk gehen nicht in die Umsatzsteuer ein, wie im Abgleich (Summen aus dem DATEV-Stapel)
      and v.source not in ('buchhaltungsbutler', 'sevdesk-export')
      ${filter.direction === "alle" ? sql`` : sql`and ${effectiveDirection("v")} = ${filter.direction}`}
      ${term ? sql`and (v.number ilike ${term} or ${effectiveContactName("v")} ilike ${term} or v.remark ilike ${term})` : sql``}
    order by v.date, v.number, v.id`),
  );
  // Was weder Einnahme noch Ausgabe ist, geht nicht in die Umsatzsteuer ein, wie im Abgleich; es steht summiert daneben
  const { rechtsform } = await loadCompany();
  const known = await loadSevdeskAccountCategories();
  const classified = [...rows].map((r) => ({
    ...r,
    neutral: neutralKindOf({ ...r, categories: sevdeskCategories(r.categories, r.position_accounts, known) }, rechtsform),
  }));
  const neutral = legacyNeutralSums(classified.flatMap((r) => (r.neutral ? [{ kind: r.neutral, direction: r.direction, gross: Number(r.gross) }] : [])));
  const all = classified
    .filter((r) => !r.neutral)
    .map((r) => ({
      id: r.id,
      type: r.type,
      direction: r.direction,
      number: r.number,
      date: r.date,
      status: r.status,
      contactName: r.contact_name,
      currency: r.currency,
      net: Number(r.net),
      tax: Number(r.tax),
      gross: Number(r.gross),
      taxes: r.taxes,
      taxType: r.tax_type,
      taxSubType: r.tax_sub_type,
      payments: legacyPayments({ source: r.source, status: r.status, gross: Number(r.gross), payment: r.payment }),
      paymentHistoryIssue: paymentHistoryIssue({ source: r.source, status: r.status, gross: Number(r.gross), payment: r.payment }),
      accountingTypeIssue: accountingTypeIssue(r.accounting_type),
      files: Number(r.files),
    }));
  const offset = filter.offset ?? 0;
  return { total: all.length, vouchers: all.slice(offset, offset + filter.limit), neutral };
}
