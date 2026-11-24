import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { pruefeAgentsMd, pruefeAnweisung, pruefeSkill } from "./regel.ts";

/* Prüft die Skills in .claude/skills/, CLAUDE.md, AGENTS.md und im Fork FORK.md nach regel.ts. Läuft mit `bun run lint`. */

const repo = fileURLToPath(new URL("../..", import.meta.url));
const wurzel = join(repo, ".claude/skills");

function alleDateien(ordner: string): string[] {
  return readdirSync(ordner, { withFileTypes: true }).flatMap((eintrag) => {
    const pfad = join(ordner, eintrag.name);
    return eintrag.isDirectory() ? alleDateien(pfad) : [pfad];
  });
}

const namen = readdirSync(wurzel, { withFileTypes: true })
  .filter((eintrag) => eintrag.isDirectory())
  .map((eintrag) => eintrag.name);

const skills = namen.flatMap((name) => {
  const ordner = join(wurzel, name);
  return pruefeSkill({
    ordner: name,
    inhalt: readFileSync(join(ordner, "SKILL.md"), "utf8"),
    dateien: alleDateien(ordner).map((datei) => relative(ordner, datei)),
  });
});

const lesen = (datei: string) => (existsSync(join(repo, datei)) ? readFileSync(join(repo, datei), "utf8") : "");
const anweisungen = [
  ...["CLAUDE.md", "AGENTS.md", "FORK.md"].flatMap((datei) => pruefeAnweisung(datei, lesen(datei))),
  ...pruefeAgentsMd(lesen("AGENTS.md"), namen, lesen("FORK.md")),
];
for (const { skill, message } of skills) console.error(`.claude/skills/${skill}: ${message}`);
for (const { skill, message } of anweisungen) console.error(`${skill}: ${message}`);
const befunde = [...skills, ...anweisungen];
if (befunde.length > 0) process.exit(1);
