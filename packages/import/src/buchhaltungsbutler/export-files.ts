import { unzipSync } from "fflate";
import { decodeText } from "../decode.ts";
import { parseCsv } from "../csv.ts";
import type { BuchhaltungsbutlerFile, BuchhaltungsbutlerRow } from "./types.ts";
import { BuchhaltungsbutlerError } from "./types.ts";

export interface ExportPart {
  name: string;
  bytes: Uint8Array;
}

export interface ExportFiles {
  datev: Uint8Array;
  /** Dateiname des Buchungsstapels ohne Ordner, auch wenn er aus einer .zip kommt */
  datevName: string;
  bb: Uint8Array;
  receipts: Uint8Array;
}

const REQUIRED_BB_COLUMNS = [
  "Datum",
  "Betrag",
  "Sollkonto",
  "Habenkonto",
  "Steuerschlüssel",
  "Buchungsnummer",
  "Rechnungsnummern",
  "Gegenpartei",
  "Umsatzsteuer",
  "Beleglinks",
] as const;

export function readBbRows(bytes: Uint8Array): BuchhaltungsbutlerRow[] {
  const rows = parseCsv(decodeText(bytes), ";").filter((row) => row.some((field) => field.trim() !== ""));
  const titles = rows.shift()?.map((title) => title.trim()) ?? [];
  for (const required of REQUIRED_BB_COLUMNS) {
    if (!titles.includes(required)) throw new BuchhaltungsbutlerError(`BB Standardexport: Spalte „${required}“ fehlt.`);
  }
  return rows.map((fields, index) => {
    if (fields.length > titles.length) throw new BuchhaltungsbutlerError(`BB Standardexport, Zeile ${index + 2}: mehr Felder als Spalten.`);
    const row: BuchhaltungsbutlerRow = { __row: String(index + 2) };
    titles.forEach((title, i) => {
      if (title) row[title] = (fields[i] ?? "").trim();
    });
    return row;
  });
}

/** Belege aus Belege.zip: nach Dateiname ohne Ordner, dazu die Dateien im älteren Muster <Buchungsnummer>.pdf */
export interface ReceiptArchive {
  byName: Map<string, BuchhaltungsbutlerFile>;
  /** Nur Dateien, die wie <Buchungsnummer>.pdf/.xml oder <Buchungsnummer>_<lfd>.pdf/.xml heißen */
  byBooking: Map<string, BuchhaltungsbutlerFile[]>;
}

/**
 * BuchhaltungsButler legt die Belege unter ihrem Originalnamen ab (Rechnung-EU-2026011.pdf); welche Datei zu welcher Buchung
 * gehört, steht in „Beleg-Dateinamen“ des BB Standardexports und als „Original-Dateiname“ im DATEV-Buchungsstapel.
 * Eine Datei kann an mehreren Buchungen hängen und liegt trotzdem nur einmal im ZIP.
 */
export function readReceiptFiles(bytes: Uint8Array): ReceiptArchive {
  const byName = new Map<string, BuchhaltungsbutlerFile>();
  const byBooking = new Map<string, BuchhaltungsbutlerFile[]>();
  for (const [path, content] of Object.entries(unzip(bytes, "Belege.zip"))) {
    if (path.endsWith("/") || path.split("/").includes("__MACOSX") || baseName(path).startsWith("._")) continue;
    const filename = baseName(path);
    if (isBediManifest(filename, content)) continue;
    const extension = /\.(pdf|xml)$/i.exec(filename)?.[1]?.toLowerCase();
    if (!extension) throw new BuchhaltungsbutlerError(`Belege.zip: „${path}“ ist weder eine PDF- noch eine XML-Datei.`);
    const role = extension === "xml" ? "xml" : "pdf";
    if (role === "pdf" && new TextDecoder().decode(content.subarray(0, 5)) !== "%PDF-") {
      throw new BuchhaltungsbutlerError(`Belege.zip: ${path} ist keine PDF-Datei.`);
    }
    if (role === "xml" && !new TextDecoder().decode(content.subarray(0, 200)).trimStart().startsWith("<")) {
      throw new BuchhaltungsbutlerError(`Belege.zip: ${path} ist keine XML-Datei.`);
    }
    if (byName.has(filename)) throw new BuchhaltungsbutlerError(`Belege.zip: Dateiname „${filename}“ kommt mehrfach vor.`);
    const file: BuchhaltungsbutlerFile = { filename, bytes: content, role };
    byName.set(filename, file);
    const match = /^(\d+)(?:_\d+)?\.(?:pdf|xml)$/i.exec(filename);
    if (match) {
      const bookingId = String(Number(match[1]));
      byBooking.set(bookingId, [...(byBooking.get(bookingId) ?? []), file]);
    }
  }
  for (const list of byBooking.values()) list.sort((a, b) => a.filename.localeCompare(b.filename, "de", { numeric: true }));
  return { byName, byBooking };
}

/** Das Verzeichnis des DATEV-Belegtransfers (GUID zu Dateiname) liegt als document.xml neben den Belegen und ist kein Beleg. */
function isBediManifest(filename: string, content: Uint8Array): boolean {
  return filename.toLowerCase() === "document.xml" && new TextDecoder().decode(content.subarray(0, 600)).includes("xml.datev.de/bedi");
}

export function readExportFiles(parts: ExportPart[]): ExportFiles {
  const files: ExportPart[] = [];
  for (const part of parts) {
    const lower = part.name.toLowerCase();
    if (lower.endsWith(".zip") && !lower.endsWith("belege.zip")) {
      for (const [name, bytes] of Object.entries(unzip(part.bytes, part.name))) {
        // Ordnereinträge und Metadaten von macOS (__MACOSX/, ._Datei) sind keine Exportdateien
        if (name.endsWith("/") || name.split("/").includes("__MACOSX") || baseName(name).startsWith("._")) continue;
        files.push({ name, bytes });
      }
    } else {
      files.push(part);
    }
  }
  const datev = uniqueFile(files, (name) => name.startsWith("extf_") && name.endsWith("_buchungsstapel.csv"), "EXTF-Buchungsstapel");
  const bb = uniqueFile(files, (name) => name.startsWith("bb_") && name.endsWith(".csv"), "BB Standardexport");
  const receipts = uniqueFile(files, (name) => name.endsWith("belege.zip"), "Belege.zip");
  return { datev: datev.bytes, datevName: baseName(datev.name), bb: bb.bytes, receipts: receipts.bytes };
}

function uniqueFile(parts: ExportPart[], matches: (name: string) => boolean, label: string): ExportPart {
  // Nach dem Dateinamen ohne Ordner, auch wenn die .zip einen Ordner enthält
  const found = parts.filter((part) => matches(baseName(part.name).toLowerCase()));
  if (found.length !== 1) throw new BuchhaltungsbutlerError(`${label}: erwartet genau eine Datei, gefunden ${found.length}.`);
  return found[0]!;
}

function unzip(bytes: Uint8Array, name: string): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes);
  } catch (error) {
    throw new BuchhaltungsbutlerError(`${name}: ZIP-Datei kann nicht gelesen werden (${error instanceof Error ? error.message : String(error)}).`);
  }
}

const baseName = (path: string) => path.split("/").pop() ?? path;
