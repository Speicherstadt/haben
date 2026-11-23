import { execFileSync } from "node:child_process";
import { vorigeFertigeVersion, zuSchliessen } from "../board/regel.ts";
import { art, type Commit, hinweise, istRc } from "./regel.ts";

/*
 * `bun scripts/release/vorschau.ts`: Stand seit dem letzten Tag, vorgeschlagene Art, Issues, die eine fertige Version
 * schließen würde, und die Hinweise für das Release. Nur mit git, nach `git fetch origin main --tags`.
 */

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
// Nur Tags von Haben (v1.2.3), nicht die der Pakete wie gobd-kern-v0.2.1
const letzter = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "origin/main");
// Gegen die fertige Version vor dem kommenden Release: bei einem laufenden RC die vor ihm
const basisTag = letzter.replace(/-rc\.\d+$/, "");
const vorige = istRc(letzter) ? vorigeFertigeVersion(tags, basisTag) : letzter;

function commits(von: string): Commit[] {
  return git("log", "--format=%x1e%s%x1f%b", `${von}..origin/main`)
    .split("\x1e")
    .filter(Boolean)
    .map((eintrag) => {
      const [titel, text = ""] = eintrag.split("\x1f");
      return { titel: titel.trim(), text };
    });
}

const seitLetztem = commits(letzter);
const seitFertig = vorige ? commits(vorige) : seitLetztem;
const dateien = git("diff", "--name-only", `${vorige ?? letzter}..origin/main`)
  .split("\n")
  .filter(Boolean);
const { vorschlag, grund } = art(letzter, dateien);
const issues = zuSchliessen(seitFertig.map((c) => `${c.titel}\n${c.text}`));

console.log(`Letzter Tag: ${letzter}${vorige && vorige !== letzter ? `, vorige fertige Version: ${vorige}` : ""}`);
console.log(`Vorschlag: ${vorschlag} (${grund})\n`);
console.log(`## Seit ${letzter} (${seitLetztem.length})\n${seitLetztem.map((c) => `- ${c.titel}`).join("\n")}\n`);
console.log(
  `## Schließt eine fertige Version\n${[...issues].map(([issue, prs]) => `- #${issue} (PR ${prs.map((p) => `#${p}`).join(", ")})`).join("\n") || "- keine"}\n`,
);
// Beim laufenden RC beide: seit ihm für einen weiteren RC, seit der vorigen fertigen Version für die fertige
if (istRc(letzter)) console.log(`## Hinweise für einen weiteren RC (seit ${letzter})\n${hinweise(seitLetztem) || "keine"}\n`);
console.log(`## Hinweise für ${istRc(letzter) ? "die fertige Version" : "das Release"} (seit ${vorige ?? letzter})\n${hinweise(seitFertig) || "keine"}`);
