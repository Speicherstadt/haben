import { monthsOfPeriod, type VatPeriod } from "@haben/core";
import type { Db, Tx } from "../../db/index.ts";
import { assetWithdrawalsForMonth, privateUseForMonth } from "../buchhaltung/index.ts";
import type { RevenueSource } from "./vat-figures.ts";

/**
 * Unentgeltliche Wertabgaben aus dem Anlagenverzeichnis, je im Monat der Leistung, auch bei Ist-Versteuerung (§ 13 Abs. 1
 * Nr. 2 UStG): die private Kfz-Nutzung (Kz 81) und entnommene Anlagen (#1970), regelbesteuert in Kz 81, als
 * Kleinunternehmer steuerfrei in Kz 48 (umsaetze-nach-leistung.ts). Das Journal bucht beides erst mit der AfA des Jahres.
 */
export async function entnahmeQuellen(period: VatPeriod, q: Db | Tx): Promise<RevenueSource[]> {
  const revenue: RevenueSource[] = [];
  for (const { year, month } of monthsOfPeriod(period)) {
    const lastDay = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    for (const use of await privateUseForMonth(year, month, q)) {
      revenue.push({
        type: "entnahme",
        date: lastDay,
        invoiceId: "",
        assetId: use.assetId,
        number: "Privatnutzung",
        customer: use.name,
        treatment: "regulaer",
        rate: 1900,
        base: use.base,
        tax: use.tax,
      });
    }
    for (const entnahme of await assetWithdrawalsForMonth(year, month, q)) {
      const kleinunternehmer = entnahme.steuer === "kleinunternehmer";
      revenue.push({
        type: "entnahme",
        date: entnahme.date,
        invoiceId: "",
        assetId: entnahme.assetId,
        number: "Entnahme",
        customer: entnahme.name,
        treatment: kleinunternehmer ? "kleinunternehmer" : "regulaer",
        rate: kleinunternehmer ? 0 : 1900,
        base: entnahme.base,
        tax: entnahme.vat,
      });
    }
  }
  return revenue;
}
