import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/*
 * Die Regel steht in keine-feste-wartezeit.grit und läuft mit `bun run lint` (biome.jsonc, plugins). Hier wird sie an
 * kleinen Beispielen geprüft: Biome liest die Datei im Repo, weil es Plugins nur dort mit der Konfiguration lädt.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));
const probe = fileURLToPath(new URL(`zz-probe-${process.pid}.ts`, import.meta.url));

afterAll(() => rmSync(probe, { force: true }));

/** Meldungen der Regel für diese Anweisung: Zahl der Fehler im Ergebnis von `biome lint` */
function findings(statement: string): number {
  writeFileSync(
    probe,
    `declare const page: any;\ndeclare const andere: any;\ndeclare const warten: number;\nexport async function probe() {\n  ${statement}\n}\n`,
  );
  const result = spawnSync("bun", ["--bun", "biome", "lint", "--only=plugin", probe], { cwd: root, encoding: "utf8", timeout: 60_000 });
  return Number(/Found (\d+) error/.exec(`${result.stdout}${result.stderr}`)?.[1] ?? 0);
}

describe("Keine feste Wartezeit in Playwright-Tests", () => {
  it.each([
    ["await page.waitForTimeout(500);", "Zahl"],
    ["await andere.waitForTimeout(warten);", "anderes Objekt, Variable"],
    ["if (warten > 0) await page.waitForTimeout(warten);", "bedingt"],
    ["await page.context().pages()[0].waitForTimeout(1_000);", "verketteter Aufruf"],
  ])("meldet %s (%s)", (statement) => {
    expect(findings(statement)).toBe(1);
  });

  it.each([
    ['await page.waitForResponse("/api");', "auf die Antwort warten"],
    ["await page.clock.runFor(300);", "Uhr vorstellen"],
    ["await new Promise((fertig) => setTimeout(fertig, 1500));", "verzögerte Antwort einer Attrappe"],
  ])("lässt %s zu (%s)", (statement) => {
    expect(findings(statement)).toBe(0);
  });
});
