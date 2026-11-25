import type { Prozent } from "@haben/core";

/**
 * Hinweis unter den Angaben, solange sie aus dem Vorjahr vorgeschlagen und nicht gespeichert sind. Lag der Hebesatz des
 * Vorjahres unter dem Mindesthebesatz des Jahres, nennt er die Anhebung (§ 16 Abs. 4 Satz 2 GewStG, #1310).
 */
export function vorschlagHinweis(year: number, hebesatz: Prozent, angehobenVon: Prozent | null): string {
  const anhebung =
    angehobenVon === null
      ? ""
      : `; den Hebesatz von ${angehobenVon} % hat Haben auf den Mindesthebesatz von ${hebesatz} % angehoben (§ 16 Abs. 4 Satz 2 GewStG)`;
  return `Vorgeschlagen aus ${year - 1}: Hebesatz und die Verlustvorträge nach der Rechnung des Vorjahres${anhebung}. Bitte mit dem Bescheid abgleichen und speichern.`;
}
