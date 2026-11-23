import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { pruefeSkill } from "./regel.ts";

/* Prüft die Skills in .claude/skills/ nach regel.ts. Läuft mit `bun run lint`. */

const wurzel = fileURLToPath(new URL("../../.claude/skills", import.meta.url));

function alleDateien(ordner: string): string[] {
  return readdirSync(ordner, { withFileTypes: true }).flatMap((eintrag) => {
    const pfad = join(ordner, eintrag.name);
    return eintrag.isDirectory() ? alleDateien(pfad) : [pfad];
  });
}

const befunde = readdirSync(wurzel, { withFileTypes: true })
  .filter((eintrag) => eintrag.isDirectory())
  .flatMap(({ name }) => {
    const ordner = join(wurzel, name);
    return pruefeSkill({
      ordner: name,
      inhalt: readFileSync(join(ordner, "SKILL.md"), "utf8"),
      dateien: alleDateien(ordner).map((datei) => relative(ordner, datei)),
    });
  });

for (const { skill, message } of befunde) console.error(`.claude/skills/${skill}: ${message}`);
if (befunde.length > 0) process.exit(1);
