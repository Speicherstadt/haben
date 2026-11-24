import type { computeUstva } from "@haben/core";
import type { PageData } from "./-zeitraum-quellen.tsx";

export type Ustva = ReturnType<typeof computeUstva>;

/** Zeilen der Umsätze, des § 13b und des innergemeinschaftlichen Erwerbs, je mit den Buchungen dahinter */
export function kennzahlZeilen(data: PageData, shown: Ustva, computed: Ustva, editable: boolean) {
  const revenue = (rate: number) => data.figures.revenue.filter((r) => r.treatment === "regulaer" && r.rate === rate);
  const treated = (treatment: string) => data.figures.revenue.filter((r) => r.treatment === treatment);
  const kz48 = [...treated("steuerfrei"), ...data.figures.kleinunternehmerUmsaetze]; // samt Umsätzen als Kleinunternehmer (#1268)
  const rows = [
    { kz: "81", field: "kz81" as const, label: "Steuerpflichtige Umsätze 19 %", base: shown.kz81, tax: shown.tax81 as number | null, sources: revenue(1900) },
    { kz: "86", field: "kz86" as const, label: "Steuerpflichtige Umsätze 7 %", base: shown.kz86, tax: shown.tax86 as number | null, sources: revenue(700) },
    {
      kz: "21",
      field: "kz21" as const,
      label: "Nicht steuerbare sonstige Leistungen im EU-Ausland (Reverse Charge)",
      base: shown.kz21,
      tax: null,
      sources: treated("reverse_charge"),
    },
    {
      kz: "45",
      field: "kz45" as const,
      label: "Übrige nicht steuerbare Umsätze (Leistungsort nicht im Inland)",
      base: shown.kz45,
      tax: null,
      sources: treated("drittland"),
    },
    {
      kz: "50",
      field: "kz50" as const,
      label: "Minderung der Bemessungsgrundlage bei Forderungsausfall (in Kz 81 und 86 enthalten)",
      base: shown.kz50,
      tax: null,
      sources: data.figures.revenue.filter((r) => r.writeOffKind === "forderungsausfall" && r.treatment === "regulaer" && (r.rate === 1900 || r.rate === 700)),
    },
    { kz: "48", field: "kz48" as const, label: "Steuerfreie Umsätze ohne Vorsteuerabzug", base: shown.kz48, tax: null, sources: kz48 },
    {
      kz: "41",
      field: "kz41" as const,
      label: "Steuerfreie innergemeinschaftliche Lieferungen an Abnehmer mit USt-IdNr.",
      base: shown.kz41,
      tax: null,
      sources: treated("ig_lieferung"),
    },
    {
      kz: "43",
      field: "kz43" as const,
      label: "Weitere steuerfreie Umsätze mit Vorsteuerabzug (Ausfuhrlieferungen)",
      base: shown.kz43,
      tax: null,
      sources: treated("ausfuhr"),
    },
    // Kz 21, 45, 50, 48, 41 und 43 nur zeigen, wenn es dort etwas gibt oder von Hand eingetragen wird
  ].filter((row) => ["81", "86"].includes(row.kz) || editable || row.base !== 0 || computed[row.field] !== 0);
  // § 13b als Leistungsempfänger: Bemessungsgrundlage und Steuer, nur wenn belegt oder von Hand
  const rcSources = (kind: "eu" | "drittland") => data.figures.reverseCharge.filter((r) => r.reverseCharge === kind);
  const rcRows = [
    {
      kz: "46",
      taxKz: "47",
      base: "kz46" as const,
      tax: "kz47" as const,
      label: "Sonstige Leistungen eines Unternehmers aus dem EU-Ausland (§ 13b Abs. 1 UStG)",
      sources: rcSources("eu"),
    },
    {
      kz: "84",
      taxKz: "85",
      base: "kz84" as const,
      tax: "kz85" as const,
      label: "Andere Leistungen, für die du die Steuer schuldest (§ 13b Abs. 2 UStG)",
      sources: rcSources("drittland"),
    },
  ].filter((row) => editable || shown[row.base] !== 0 || shown[row.tax] !== 0 || computed[row.base] !== 0 || computed[row.tax] !== 0);
  // Innergemeinschaftlicher Erwerb: Bemessungsgrundlage 89/93, die Steuer rechnet das Formular daraus; Vorsteuer in Kz 61
  const igeSources = (rate: number) => data.figures.igErwerb.filter((r) => r.rate === rate);
  const igeRows = [
    { kz: "89", field: "kz89" as const, label: "Steuerpflichtige innergemeinschaftliche Erwerbe 19 %", tax: shown.tax89, sources: igeSources(1900) },
    { kz: "93", field: "kz93" as const, label: "Steuerpflichtige innergemeinschaftliche Erwerbe 7 %", tax: shown.tax93, sources: igeSources(700) },
  ].filter((row) => editable || shown[row.field] !== 0 || computed[row.field] !== 0);
  return { rows, rcRows, igeRows };
}
