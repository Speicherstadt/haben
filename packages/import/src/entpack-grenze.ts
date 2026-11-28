import { gunzipSync as gunzipNode } from "node:zlib";
import { unzipSync } from "fflate";

/*
 * Grenze beim Entpacken hochgeladener Archive (Zip-Bombe). Eine kleine ZIP- oder gzip-Datei kann zu Gigabytes
 * anschwellen und den Speicher der App füllen, bevor der Import merkt, dass der Inhalt nicht passt. Auslösen kann das
 * nur, wer angemeldet ist und importieren darf; die Grenze schützt trotzdem vor einer präparierten Datei aus fremder Hand.
 */

/** Das Archiv ist entpackt viel größer als die Datei selbst und wird nicht gelesen */
export class EntpackGrenzeError extends Error {}

/**
 * Wie weit ein Archiv beim Entpacken wachsen darf: das Zwanzigfache der Datei plus 64 MiB, höchstens 2 GiB. Echte
 * Exporte bestehen aus PDF und Bildern (kaum komprimierbar) sowie CSV, JSON und XML (gut komprimierbar) und bleiben weit
 * darunter.
 */
export function maxUnpackedBytes(packedBytes: number): number {
  return Math.min(2 * 1024 ** 3, 64 * 1024 ** 2 + 20 * packedBytes);
}

/**
 * `unzipSync` mit Grenze. fflate legt den Speicher je Eintrag nach der Größe im ZIP-Verzeichnis an und schneidet
 * Überlanges ab; die Summe dieser Angaben zu prüfen, bevor entpackt wird, begrenzt deshalb den Speicherbedarf. Gezählt
 * wird das Größere aus entpackter und gepackter Größe: Ein gespeicherter Eintrag (ohne Kompression) liest fflate mit der
 * gepackten Größe, mehrere Einträge dürfen auf denselben Datenblock zeigen, und eine falsche „0“ als entpackte Größe darf
 * die Grenze nicht umgehen. Zu groß: EntpackGrenzeError; ein kaputtes ZIP: der Fehler von fflate wie bisher.
 */
export function unzipBegrenzt(bytes: Uint8Array, limit = maxUnpackedBytes(bytes.length)): Record<string, Uint8Array> {
  let total = 0;
  let tooLarge = false;
  try {
    return unzipSync(bytes, {
      filter: (file) => {
        total += Math.max(file.size, file.originalSize);
        if (total > limit) {
          tooLarge = true;
          throw new Error("zu groß");
        }
        return true;
      },
    });
  } catch (error) {
    if (tooLarge) throw new EntpackGrenzeError("Die Datei ist entpackt viel größer als gepackt und wird nicht gelesen.");
    throw error;
  }
}

/** gunzip mit derselben Grenze; gzip nennt die Größe nicht vorab, zlib bricht deshalb beim Entpacken an der Grenze ab */
export function gunzipBegrenzt(bytes: Uint8Array, limit = maxUnpackedBytes(bytes.length)): Uint8Array {
  try {
    return new Uint8Array(gunzipNode(bytes, { maxOutputLength: limit }));
  } catch (error) {
    if (error instanceof RangeError || (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new EntpackGrenzeError("Die Datei ist entpackt viel größer als gepackt und wird nicht gelesen.");
    }
    throw error;
  }
}
