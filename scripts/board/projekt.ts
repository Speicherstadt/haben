/*
 * Welches Project (Board) die Automatik bewegt. Ohne Einstellung ist es das Board von Haben; ein Repository mit eigenem
 * Board (Haben AT) setzt seine Nummer als Variable BOARD_NUMMER (Settings → Secrets and variables → Actions → Variables).
 */

export const BOARD_INHABER = "Speicherstadt";
const BOARD_VON_HABEN = 3;

/** Ein unbrauchbarer Wert bricht ab: Der Rückfall auf Board 3 schriebe Karten auf ein fremdes Board */
export function boardNummer(): number {
  const wert = process.env.BOARD_NUMMER?.trim();
  if (!wert) return BOARD_VON_HABEN;
  if (!/^[1-9]\d*$/.test(wert)) throw new Error(`BOARD_NUMMER ist keine Nummer eines Projects: „${wert}“`);
  return Number(wert);
}

export function boardLink(): string {
  return `[Board](https://github.com/orgs/${BOARD_INHABER}/projects/${boardNummer()})`;
}
