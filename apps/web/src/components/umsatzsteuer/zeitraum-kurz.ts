import { MONTHS, VAT_FREQUENCY_LABEL } from "@haben/core";
import type { getVatPeriod } from "../../server/functions/vat.ts";

/** Der eingestellte Zeitraum in Worten: „monatlich“, bei Wechsel im Jahr „monatlich, ab Juli: vierteljährlich“ */
export const zeitraumKurz = (overview: Awaited<ReturnType<typeof getVatPeriod>>["frequency"]) =>
  overview.own.length > 0
    ? overview.own.map((s) => `${s.fromMonth === 1 ? "" : `ab ${MONTHS[s.fromMonth - 1]}: `}${VAT_FREQUENCY_LABEL[s.frequency]}`).join(", ")
    : VAT_FREQUENCY_LABEL[overview.frequency];
