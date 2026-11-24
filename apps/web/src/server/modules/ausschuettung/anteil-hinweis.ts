import { abweichendeAnteile, formatPercent, type BasisPoints, type Cents } from "@haben/core";

/**
 * Anteil in Prozent, der nicht zur Beteiligung in Euro passt: Bis #1286 verteilte Haben nach dem Prozentwert, seitdem nach
 * der Beteiligung. Widersprechen sich beide, ändern sich die Beträge; der Vorschlag warnt, statt anzuhalten.
 */
export function anteilHinweis(year: number, anteilseigner: readonly { name: string; beteiligung: Cents; anteil: BasisPoints }[]): string[] {
  const abweichend = abweichendeAnteile(anteilseigner);
  if (abweichend.length === 0) return [];
  const liste = abweichend
    .map(
      ({ index, nachBeteiligung }) =>
        `${anteilseigner[index]!.name} ${formatPercent(anteilseigner[index]!.anteil)} (nach der Beteiligung ${formatPercent(nachBeteiligung)})`,
    )
    .join(", ");
  return [
    `Für ${year} passt der Anteil in Prozent nicht zur Beteiligung in Euro: ${liste}. Haben verteilt nach der Beteiligung in Euro (§ 29 Abs. 3 Satz 1 GmbHG); ` +
      "stimmt sie nicht, korrigiere sie vor dem Buchen (Jahreserklärung › Angaben zu den Erklärungen).",
  ];
}
