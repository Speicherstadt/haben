import type { ReceiptArchive } from "./export-files.ts";
import type { BuchhaltungsbutlerFile, BuchhaltungsbutlerJoinedRow } from "./types.ts";
import { BuchhaltungsbutlerError } from "./types.ts";

/**
 * Die Belegdateien je Buchungsnummer. Die Namen stehen in „Beleg-Dateinamen“ (BB Standardexport), sonst in „Original-Dateiname“
 * (DATEV) oder am Ende der Beleg-URL. Findet sich keine dieser Dateien, gilt das ältere Muster <Buchungsnummer>.pdf.
 */
export function assignReceipts(rows: BuchhaltungsbutlerJoinedRow[], archive: ReceiptArchive): Map<string, BuchhaltungsbutlerFile[]> {
  const named = rows.map((row) => ({ id: row.info.bookingId, ...receiptNames(row, archive) }));
  // Welche Buchungen eine Datei beim Namen nennen
  const claims = new Map<string, Set<string>>();
  for (const { id, names } of named) {
    for (const name of names) claims.set(name, (claims.get(name) ?? new Set<string>()).add(id));
  }
  return new Map(
    named.map(({ id, names, fromUrl }) => {
      // Eine Datei, die nur andere Buchungen nennen, gehört nicht allein wegen ihrer Nummer hierher
      const legacy = (archive.byBooking.get(id) ?? []).filter((file) => claims.get(file.filename)?.has(id) !== false);
      const found = names.flatMap((name) => archive.byName.get(name) ?? []);
      const complete = names.length > 0 && found.length === names.length;
      // Das ältere Muster ersetzt keine halb gefundene Liste. Endet die Beleg-URL nur auf eine von mehreren Nummerndateien,
      // gehören trotzdem alle zur Buchung.
      const urlWithinLegacy = fromUrl && complete && found.every((file) => legacy.includes(file));
      if (legacy.length > 0 && (found.length === 0 || urlWithinLegacy)) return [id, legacy];
      if (complete) return [id, found];
      const missing = names.filter((name) => !archive.byName.has(name));
      const detail = missing.length > 0 ? ` (gesucht: ${missing.join(", ")})` : "";
      throw new BuchhaltungsbutlerError(`Buchung ${id}: Beleg-URL vorhanden, aber PDF fehlt in Belege.zip${detail}.`);
    }),
  );
}

function receiptNames(row: BuchhaltungsbutlerJoinedRow, archive: ReceiptArchive): { names: string[]; fromUrl: boolean } {
  const listed = (row.bb["Beleg-Dateinamen"] ?? "").trim() || (row.info.raw["Original-Dateiname"] ?? "").trim();
  if (listed) return { names: splitNames(listed, archive), fromUrl: false };
  const names = row.info.url
    .split(/,\s*(?=https?:\/\/)/)
    .map(nameOfUrl)
    .filter(Boolean);
  return { names, fromUrl: true };
}

/** Mehrere Dateien stehen mit Komma getrennt in einem Feld; ein Name, der selbst (mit Komma) im ZIP liegt, geht vor. */
function splitNames(listed: string, archive: ReceiptArchive): string[] {
  const parts = listed.split(",");
  const names: string[] = [];
  for (let start = 0; start < parts.length; ) {
    let end = parts.length;
    while (end > start + 1 && !archive.byName.has(parts.slice(start, end).join(",").trim())) end--;
    const name = parts.slice(start, end).join(",").trim();
    if (name) names.push(name);
    start = end;
  }
  return names;
}

function nameOfUrl(url: string): string {
  const last = url.trim().split(/[?#]/)[0]!.split("/").pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
