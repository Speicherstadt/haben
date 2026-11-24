import { beforeEach, describe, expect, it } from "vitest";
import { JOBS, recordElsterSubmission, recordJobRun, renderMetrics, resetMetrics } from "./metriken.ts";

/**
 * Prüft das Textformat 0.0.4 (Prometheus, Exposition formats) streng genug für Prometheus: HELP und TYPE vor den Werten
 * einer Familie, Namen und Labels nach den Namensregeln, Werte als Zahl, keine Reihe doppelt. Gibt die Fehler zurück.
 */
function formatFehler(text: string): string[] {
  const fehler: string[] = [];
  if (!text.endsWith("\n")) fehler.push("Zeilenumbruch am Ende fehlt");
  const NAME = "[a-zA-Z_:][a-zA-Z0-9_:]*";
  const LABEL = `[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\\\\n]|\\\\[\\\\"n])*"`;
  const sample = new RegExp(`^(${NAME})(?:\\{(${LABEL}(?:,${LABEL})*)?\\})? (-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?|NaN|[+-]Inf)$`);
  const typen = new Map<string, string>();
  const reihen = new Set<string>();
  let familie: string | undefined;
  for (const zeile of text.replace(/\n$/, "").split("\n")) {
    const help = new RegExp(`^# HELP (${NAME}) \\S`).exec(zeile);
    const type = new RegExp(`^# TYPE (${NAME}) (counter|gauge)$`).exec(zeile);
    const wert = sample.exec(zeile);
    if (help) familie = help[1];
    else if (type) {
      if (type[1] !== familie || typen.has(type[1]!)) fehler.push(`TYPE ohne HELP davor oder doppelt: ${zeile}`);
      typen.set(type[1]!, type[2]!);
    } else if (wert) {
      if (wert[1] !== familie || !typen.has(wert[1]!)) fehler.push(`Wert außerhalb seiner Familie: ${zeile}`);
      if (typen.get(wert[1]!) === "counter" && !wert[1]!.endsWith("_total")) fehler.push(`Zähler ohne _total: ${zeile}`);
      const reihe = `${wert[1]}{${wert[2] ?? ""}}`;
      if (reihen.has(reihe)) fehler.push(`Reihe doppelt: ${zeile}`);
      reihen.add(reihe);
    } else fehler.push(`Zeile ungültig: ${zeile}`);
  }
  return fehler;
}

const wert = (text: string, reihe: string) =>
  text
    .split("\n")
    .find((z) => z.startsWith(`${reihe} `))
    ?.split(" ")[1];

describe("Metriken für Prometheus", () => {
  beforeEach(() => resetMetrics());

  it("gibt vor dem ersten Lauf gültiges Textformat aus, mit Zählern für jeden Job und ohne Zeitpunkte", () => {
    const text = renderMetrics({ version: "1.2.3", commit: null, up: false });
    expect(formatFehler(text)).toEqual([]);
    expect(wert(text, 'haben_info{version="1.2.3",commit=""}')).toBe("1");
    expect(wert(text, "haben_up")).toBe("0");
    for (const task of JOBS) expect(wert(text, `haben_job_failures_total{task="${task}"}`)).toBe("0");
    expect(text).not.toMatch(/^haben_job_last_(run|success)_timestamp_seconds\{/m);
    expect(text).not.toMatch(/^haben_backup_last_success_timestamp_seconds\{/m);
  });

  it("ein gescheiterter Lauf erhöht die Fehler und lässt den letzten Erfolg stehen, ein erfolgreicher setzt ihn", () => {
    recordJobRun("fints_sync", true, 1_700_000_000_000);
    recordJobRun("fints_sync", false, 1_700_003_600_000);
    recordJobRun("fints_sync", false, 1_700_007_200_000);
    let text = renderMetrics({ version: "1.2.3", commit: "abc", up: true });
    expect(formatFehler(text)).toEqual([]);
    expect(wert(text, 'haben_job_failures_total{task="fints_sync"}')).toBe("2");
    expect(wert(text, 'haben_job_last_success_timestamp_seconds{task="fints_sync"}')).toBe("1700000000");
    expect(wert(text, 'haben_job_last_run_timestamp_seconds{task="fints_sync"}')).toBe("1700007200");
    expect(wert(text, 'haben_job_failures_total{task="bank_sync"}')).toBe("0");

    recordJobRun("fints_sync", true, 1_700_010_800_500);
    text = renderMetrics({ version: "1.2.3", commit: "abc", up: true });
    expect(wert(text, 'haben_job_last_success_timestamp_seconds{task="fints_sync"}')).toBe("1700010800.5");
    expect(wert(text, 'haben_job_failures_total{task="fints_sync"}')).toBe("2");
  });

  it("zählt ELSTER-Antworten je Vorgang und Ergebnis und nennt das Backup nur mit Stand", () => {
    recordElsterSubmission("send", true);
    recordElsterSubmission("send", false);
    recordElsterSubmission("send", true);
    const text = renderMetrics({ version: null, commit: null, up: true, backup: { backup: new Date("2026-11-24T03:15:00Z"), restoreCheck: null } });
    expect(formatFehler(text)).toEqual([]);
    expect(wert(text, 'haben_elster_submissions_total{kind="send",result="ok"}')).toBe("2");
    expect(wert(text, 'haben_elster_submissions_total{kind="send",result="error"}')).toBe("1");
    expect(wert(text, 'haben_elster_submissions_total{kind="validate",result="ok"}')).toBe("0");
    expect(wert(text, 'haben_backup_last_success_timestamp_seconds{kind="backup"}')).toBe(String(Date.parse("2026-11-24T03:15:00Z") / 1000));
    expect(text).not.toContain('kind="restore_check"');
  });

  it("maskiert Anführungszeichen, Backslash und Zeilenumbruch in Labels", () => {
    const text = renderMetrics({ version: '1"\\\n', commit: null, up: true });
    expect(formatFehler(text)).toEqual([]);
    expect(text).toContain('haben_info{version="1\\"\\\\\\n",commit=""} 1');
  });

  it("die Prüfung des Formats erkennt Fehler", () => {
    expect(formatFehler("haben_up 1\n")).toEqual(["Wert außerhalb seiner Familie: haben_up 1"]);
    expect(formatFehler('# HELP a x\n# TYPE a gauge\na{b="c} 1\n')).toEqual(['Zeile ungültig: a{b="c} 1']);
    expect(formatFehler("# HELP a x\n# TYPE a counter\na 1\na 2")).toEqual([
      "Zeilenumbruch am Ende fehlt",
      "Zähler ohne _total: a 1",
      "Zähler ohne _total: a 2",
      "Reihe doppelt: a 2",
    ]);
  });
});
