/*
 * Zähler für /api/metrics (#1858): Läufe der Hintergrundjobs und ELSTER-Übermittlungen seit dem Start des Prozesses.
 * Nur Zeitpunkte und Anzahlen mit festen Labels, nie Meldungen, Namen, Beträge oder IDs. Nach einem Neustart fangen
 * sie bei null an; Prometheus erkennt zurückgesprungene Zähler selbst.
 */

/** Feste Namen der Hintergrundjobs, englisch wie /api/health; Monitore und Alarmregeln verlassen sich auf sie */
export const JOBS = [
  "recurring_invoices",
  "archive_delivery",
  "recurring_receipts",
  "bank_duplicate_check",
  "bank_sync",
  "fints_sync",
  "store_reports",
  "etsy_sync",
  "paypal_sync",
  "stripe_sync",
  "elster_mailbox",
  "exchange_rates",
  "base_rate",
  "receipt_inbox",
  "vat_id_check",
  "deadline_mails",
  "file_check",
  "audit_checksum_mail",
] as const;
export type Job = (typeof JOBS)[number];

/** validate: nur prüfen, test: Testübermittlung, send: echt (ElsterVorgang) */
const ELSTER_KINDS = ["validate", "test", "send"] as const;
const ELSTER_RESULTS = ["ok", "error"] as const;
type ElsterKind = (typeof ELSTER_KINDS)[number];

interface JobStand {
  lastRun?: number;
  lastSuccess?: number;
  failures: number;
}

interface Stand {
  jobs: Map<Job, JobStand>;
  elster: Map<string, number>;
}

/** Auf globalThis wie der Scheduler: Plugin und Route teilen sich so denselben Stand, auch nach einem Neuladen im Entwicklungsserver */
function stand(): Stand {
  const g = globalThis as { __habenMetriken?: Stand };
  g.__habenMetriken ??= { jobs: new Map(), elster: new Map() };
  return g.__habenMetriken;
}

/** Nur für Tests */
export function resetMetrics(): void {
  delete (globalThis as { __habenMetriken?: Stand }).__habenMetriken;
}

/** Ein Lauf eines Jobs; ein gescheiterter zählt als Fehler und lässt den letzten Erfolg stehen */
export function recordJobRun(job: Job, ok: boolean, at = Date.now()): void {
  const jobs = stand().jobs;
  const s = jobs.get(job) ?? { failures: 0 };
  s.lastRun = at;
  if (ok) s.lastSuccess = at;
  else s.failures++;
  jobs.set(job, s);
}

/** Eine Antwort von ERiC auf Prüfen oder Senden; ok ist das Ergebnis, nicht der Inhalt */
export function recordElsterSubmission(kind: ElsterKind, ok: boolean): void {
  const key = `${kind}:${ok ? "ok" : "error"}`;
  const elster = stand().elster;
  elster.set(key, (elster.get(key) ?? 0) + 1);
}

export interface MetricsInput {
  version: string | null;
  commit: string | null;
  up: boolean;
  /** Letztes gelungenes Backup und letzter gelungener Test-Restore aus backup_status; fehlt, wenn die Datenbank nicht antwortet */
  backup?: { backup: Date | null; restoreCheck: Date | null };
}

type Sample = [labels: Record<string, string>, value: number];

/** Textformat 0.0.4 (Prometheus, Exposition formats): Backslash, Anführungszeichen und Zeilenumbruch maskiert */
const escapeLabel = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

function family(name: string, type: "gauge" | "counter", help: string, samples: Sample[]): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const [labels, value] of samples) {
    const pairs = Object.entries(labels).map(([key, v]) => `${key}="${escapeLabel(v)}"`);
    lines.push(`${name}${pairs.length ? `{${pairs.join(",")}}` : ""} ${value}`);
  }
  return lines.join("\n");
}

const seconds = (ms: number) => ms / 1000;

/*
 * Das Label heißt `task`, nicht `job`: `job` setzt Prometheus selbst für das Scrape-Ziel und benennt ein gleichnamiges
 * Label der Ausgabe in `exported_job` um. Zeitpunkte fehlen, solange es seit dem Start keinen Lauf bzw. Erfolg gab.
 */
export function renderMetrics(input: MetricsInput): string {
  const { jobs, elster } = stand();
  const zeitpunkte = (feld: "lastRun" | "lastSuccess") =>
    JOBS.flatMap((task): Sample[] => {
      const at = jobs.get(task)?.[feld];
      return at ? [[{ task }, seconds(at)]] : [];
    });
  const backups = Object.entries({ backup: input.backup?.backup, restore_check: input.backup?.restoreCheck }).flatMap(([kind, at]): Sample[] =>
    at ? [[{ kind }, seconds(at.getTime())]] : [],
  );
  const families = [
    family("haben_info", "gauge", "Version und Commit dieser Instanz", [[{ version: input.version ?? "", commit: input.commit ?? "" }, 1]]),
    family("haben_up", "gauge", "1, wenn /api/health pass meldet (Datenbank erreichbar, Migrationen angewendet), sonst 0", [[{}, input.up ? 1 : 0]]),
    family("haben_job_last_run_timestamp_seconds", "gauge", "Ende des letzten Laufs eines Hintergrundjobs seit dem Start", zeitpunkte("lastRun")),
    family(
      "haben_job_last_success_timestamp_seconds",
      "gauge",
      "Ende des letzten erfolgreichen Laufs eines Hintergrundjobs seit dem Start",
      zeitpunkte("lastSuccess"),
    ),
    family(
      "haben_job_failures_total",
      "counter",
      "Gescheiterte Läufe eines Hintergrundjobs seit dem Start",
      JOBS.map((task): Sample => [{ task }, jobs.get(task)?.failures ?? 0]),
    ),
    family(
      "haben_elster_submissions_total",
      "counter",
      "Antworten von ERiC auf Prüfen (validate), Testübermittlung (test) und Echtübermittlung (send) seit dem Start, nach Ergebnis",
      ELSTER_KINDS.flatMap((kind) => ELSTER_RESULTS.map((result): Sample => [{ kind, result }, elster.get(`${kind}:${result}`) ?? 0])),
    ),
    family(
      "haben_backup_last_success_timestamp_seconds",
      "gauge",
      "Letztes gelungenes Backup (backup) und letzter gelungener Test-Restore (restore_check)",
      backups,
    ),
  ];
  return `${families.join("\n")}\n`;
}
