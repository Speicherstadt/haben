import type { Cents, TaxTreatment } from "@haben/core";
import type { RevenueSource } from "./vat-figures.ts";

/** Erläuterung einer Ausbuchung je Steuersatz: Skonto gewährt oder Forderungsausfall (dieser zählt zusätzlich in Kz 50) */
export function ausbuchungsQuelle(
  r: {
    date: string;
    writeOffKind: string;
    invoiceId: string;
    number: string | null;
    buyer: { name?: string } | null;
    treatment: TaxTreatment;
    exemptionReason: string;
  },
  share: { rate: number; base: Cents; tax: Cents },
): RevenueSource {
  return {
    type: "ausbuchung",
    writeOffKind: r.writeOffKind === "forderungsausfall" ? "forderungsausfall" : "skonto",
    date: r.date,
    invoiceId: r.invoiceId,
    number: r.number ?? "",
    customer: r.buyer?.name ?? "",
    treatment: r.treatment,
    exemptionReason: r.exemptionReason,
    rate: share.rate,
    base: share.base,
    tax: share.tax,
  };
}
