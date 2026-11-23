import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Vorschau gegen ein kleines Repo mit laufendem RC: Wird daraus die fertige Version, braucht sie die Hinweise seit
// der vorigen fertigen Version (Skill `release`, Schritt 3), auch die aus Pull Requests vor dem RC.
const skript = resolve(__dirname, "vorschau.ts");
const ordner = mkdtempSync(join(tmpdir(), "vorschau-"));
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (...args: string[]) => execFileSync("git", args, { cwd: ordner, env, encoding: "utf8" });
afterAll(() => rmSync(ordner, { recursive: true, force: true }));

function commit(nachricht: string) {
  writeFileSync(join(ordner, "f.txt"), nachricht);
  git("add", ".");
  git("commit", "-q", "-m", nachricht);
}

describe("vorschau bei laufendem RC", () => {
  it("nennt die Hinweise für die fertige Version seit der vorigen fertigen Version", () => {
    git("init", "-q");
    commit("Release v0.1.0");
    git("tag", "v0.1.0");
    commit("Bank: vor dem RC (#1)\n\n## Für das Release\nVor dem RC beachten.");
    commit("Release v0.2.0-rc.1");
    git("tag", "v0.2.0-rc.1");
    commit("Bank: Fix nach dem RC (#2)\n\n## Für das Release\nNach dem RC beachten.");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    const ausgabe = execFileSync("bun", [skript], { cwd: ordner, env, encoding: "utf8" });
    expect(ausgabe).toContain("Nach dem RC beachten.");
    expect(ausgabe).toContain("Vor dem RC beachten.");
  });
});
