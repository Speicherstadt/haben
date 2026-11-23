/*
 * Prüfsumme des Sollbestands der Sperren (#1683), wie „Kette prüfen“ sie für den eigenen Bestand zeigt.
 * Aufruf: bun scripts/sollbestand/pruefsumme.ts [datei]; ohne Datei apps/web/src/server/db/trigger-inventory.json.
 * Der Release-Workflow hängt die Datei an das GitHub-Release und schreibt die Ausgabe in die Release Notes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Sollbestand } from "../../packages/gobd-kern/src/sperren/bestand.ts";
import { pruefsumme } from "../../packages/gobd-kern/src/sperren/pruefsumme.ts";

const datei = process.argv[2] ?? fileURLToPath(new URL("../../apps/web/src/server/db/trigger-inventory.json", import.meta.url));
console.log(pruefsumme(JSON.parse(readFileSync(datei, "utf8")) as Sollbestand));
