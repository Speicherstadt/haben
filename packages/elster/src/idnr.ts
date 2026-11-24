/**
 * Steuerliche Identifikationsnummer: In den ersten zehn Ziffern kommt genau eine Ziffer zwei- oder dreimal
 * vor (dreimal nicht direkt hintereinander), alle anderen höchstens einmal; dazu die Prüfziffer nach
 * ISO 7064, MOD 11,10.
 */
export function isValidIdnr(idnr: string): boolean {
  if (!/^[1-9]\d{10}$/.test(idnr)) return false;
  const counts = [..."0123456789"].map((d) => idnr.slice(0, 10).split(d).length - 1);
  const repeated = counts.filter((n) => n > 1);
  if (repeated.length !== 1 || repeated[0]! > 3 || /(\d)\1\1/.test(idnr.slice(0, 10))) return false;
  let product = 10;
  for (const digit of idnr.slice(0, 10)) {
    let sum = (Number(digit) + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  const check = (11 - product) % 10;
  return check === Number(idnr[10]);
}
