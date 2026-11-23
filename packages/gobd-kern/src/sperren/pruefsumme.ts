import { createHash } from "node:crypto";
import type { Sollbestand } from "./bestand.ts";

/** Werte mit sortierten Schlüsseln und Listen, damit Reihenfolge und Formatierung der Datei nicht zählen */
function kanonisch(wert: unknown): string {
  if (Array.isArray(wert)) return `[${wert.map(kanonisch).sort().join(",")}]`;
  if (wert !== null && typeof wert === "object") {
    const eintraege = Object.entries(wert).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${eintraege.map(([schluessel, inhalt]) => `${JSON.stringify(schluessel)}:${kanonisch(inhalt)}`).join(",")}}`;
  }
  return JSON.stringify(wert);
}

/**
 * SHA-256 über einen Bestand, ohne die eingebauten Funktionen von PostgreSQL: Die hängen von der Version des Servers ab
 * (katalog.ts), die Prüfsumme soll auf jeder unterstützten Version dieselbe sein. Alle Listen des Bestands sind Mengen,
 * deshalb zählt ihre Reihenfolge nicht. Eine Instanz, deren Bestand dem ausgelieferten Sollbestand gleicht, hat dessen
 * Prüfsumme; so lässt sie sich mit der veröffentlichten vergleichen.
 */
export function pruefsumme(bestand: Sollbestand): string {
  const { builtins: _eingebaute, ...ohneEingebaute } = bestand;
  return createHash("sha256").update(kanonisch(ohneEingebaute)).digest("hex");
}
