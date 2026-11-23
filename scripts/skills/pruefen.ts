import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { pruefeAgentsMd, pruefeAnweisung, pruefeSkill } from "./regel.ts";

/* Prüft die Skills in .claude/skills/, CLAUDE.md und AGENTS.md nach regel.ts. Läuft mit `bun run lint`. */

const repo = fileURLToPath(new URL("../..", import.meta.url));
const wurzel = join(repo, ".claude/skills");

function alleDateien(ordner: string): string[] {
  return readdirSync(ordner, { withFileTypes: true }).flatMap((eintrag) => {
    const pfad = join(ordner, eintrag.name);
    return eintrag.isDirectory() ? alleDateien(pfad) : [pfad];
  });
}

const skills = readdirSync(wurzel, { withFileTypes: true })
  .filter((eintrag) => eintrag.isDirectory())
  .flatMap(({ name }) => {
    const ordner = join(wurzel, name);
    return pruefeSkill({
      ordner: name,
      inhalt: readFileSync(join(ordner, "SKILL.md"), "utf8"),
      dateien: alleDateien(ordner).map((datei) => relative(ordner, datei)),
    });
  });

const anweisungen = [
  ...["CLAUDE.md", "AGENTS.md"].flatMap((datei) => pruefeAnweisung(datei, readFileSync(join(repo, datei), "utf8"))),
  ...pruefeAgentsMd(
    readFileSync(join(repo, "AGENTS.md"), "utf8"),
    readdirSync(wurzel, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  ),
];
for (const { skill, message } of skills) console.error(`.claude/skills/${skill}: ${message}`);
for (const { skill, message } of anweisungen) console.error(`${skill}: ${message}`);
const befunde = [...skills, ...anweisungen];
if (befunde.length > 0) process.exit(1);
