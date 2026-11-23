import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { type PullRequest, rangliste } from "./regel.ts";

/*
 * Vorschlag für die Rangliste der offenen Pull Requests (Skill `prs-abarbeiten`, Schritt 2), mit gh.
 * `bun scripts/prs/rangliste.ts [--maintainer login,login] [--json]`. Kommentare dieser Konten zählen als „unsere“.
 */

const { values } = parseArgs({ options: { maintainer: { type: "string", default: "firsttris" }, json: { type: "boolean", default: false } } });
const felder = "number,title,author,isDraft,isCrossRepository,mergeable,headRefOid,createdAt,files,statusCheckRollup,comments,commits";
const prs: PullRequest[] = JSON.parse(
  execFileSync("gh", ["pr", "list", "--repo", "Speicherstadt/haben", "--state", "open", "--limit", "100", "--json", felder], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const liste = rangliste(prs, values.maintainer.split(","));

if (values.json) console.log(JSON.stringify(liste, null, 2));
else {
  console.log("| Platz | PR | Titel | CI | Grund |\n| --- | --- | --- | --- | --- |");
  for (const l of liste)
    console.log(`| ${l.platz} | #${l.number} | ${l.title} | ${l.ci} | ${l.grund}${l.migrationen.length ? ` (${l.migrationen.join(", ")})` : ""} |`);
}
