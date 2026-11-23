import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { currentDay, SESSION } from "./daten.ts";
import { appDatabaseUrlFuer, databaseUrlFuer } from "./durchlaeufe.ts";

/**
 * Abzug des Stands nach app.spec.ts (#1742): die Datenbank als Vorlage daneben (CREATE DATABASE … TEMPLATE), dazu die
 * Belegdateien und die Sitzung. „mit-daten“ beginnt mit dem Einspielen statt mit der Einrichtung im Browser; mit
 * E2E_ABZUG=1 aus einem früheren Lauf, ohne „ablauf“ (playwright.config.ts). Eine Vorlagendatenbank braucht kein
 * pg_dump in der Version des Servers, Sichern und Einspielen dauern Sekunden.
 * https://www.postgresql.org/docs/18/manage-ag-templatedbs.html
 */

const ORDNER = fileURLToPath(new URL("../.e2e-abzug/", import.meta.url));
// Muss zu DOCUMENTS_DIR des Hauptservers in playwright.config.ts passen
const BELEGE = process.env.E2E_DOCUMENTS_DIR ?? "test-results/e2e-belege";
const INFO = `${ORDNER}info.json`;

/** Was den Stand bestimmt: Migrationen, die Einrichtung und der Tag, von dem aus die Daten datiert sind */
export function fingerabdruck(): string {
  const hash = createHash("sha256");
  const drizzle = fileURLToPath(new URL("../drizzle/", import.meta.url));
  for (const datei of readdirSync(drizzle)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    hash.update(readFileSync(drizzle + datei));
  for (const datei of ["app.spec.ts", "einrichtung.ts", "daten.ts", "abzug.ts"]) hash.update(readFileSync(new URL(datei, import.meta.url)));
  hash.update(currentDay());
  return hash.digest("hex");
}

/** Die Vorlage liegt neben der E2E-Datenbank und endet wie verlangt auf „e2e“: haben_e2e → haben_abzug_e2e */
function namen() {
  const url = new URL(databaseUrlFuer());
  const ziel = url.pathname.slice(1);
  if (!/e2e$/i.test(ziel)) throw new Error(`Die E2E-Datenbank muss auf „e2e“ enden, nicht „${ziel}“.`);
  return { url, ziel, vorlage: ziel.replace(/e2e$/i, "abzug_e2e") };
}

const bezeichner = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** `quelle` als `kopie` anlegen. Der laufende Server baut getrennte Verbindungen neu auf, deshalb mehrere Versuche */
async function kopieren(admin: postgres.Sql, quelle: string, kopie: string) {
  await admin.unsafe(`drop database if exists ${bezeichner(kopie)} with (force)`);
  for (let versuch = 1; ; versuch++) {
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${quelle} and pid <> pg_backend_pid()`;
    try {
      await admin.unsafe(`create database ${bezeichner(kopie)} template ${bezeichner(quelle)}`);
      return;
    } catch (error) {
      // 55006 object_in_use: eine Verbindung zur Quelle kam zwischen Trennen und Kopieren wieder
      if ((error as { code?: string }).code !== "55006" || versuch === 20) throw error;
      await new Promise((weiter) => setTimeout(weiter, 100));
    }
  }
}

const verwaltung = (url: URL) => postgres(Object.assign(new URL(url), { pathname: "/postgres" }).toString(), { max: 1, onnotice: () => {} });

/** Nach app.spec.ts: Datenbank, Belege und Sitzung sichern */
export async function abzugSichern(): Promise<void> {
  const { url, ziel, vorlage } = namen();
  const admin = verwaltung(url);
  try {
    await kopieren(admin, ziel, vorlage);
  } finally {
    await admin.end();
  }
  rmSync(ORDNER, { recursive: true, force: true });
  mkdirSync(ORDNER, { recursive: true });
  if (existsSync(BELEGE)) cpSync(BELEGE, `${ORDNER}belege`, { recursive: true });
  cpSync(SESSION, `${ORDNER}sitzung.json`);
  writeFileSync(INFO, JSON.stringify({ fingerabdruck: fingerabdruck(), vorlage }));
}

/** Warum es keinen passenden Abzug gibt, oder null */
export function abzugFehlt(): string | null {
  if (!existsSync(INFO)) return "Es gibt noch keinen Abzug.";
  const info = JSON.parse(readFileSync(INFO, "utf8")) as { fingerabdruck: string };
  return info.fingerabdruck === fingerabdruck() ? null : "Der Abzug passt nicht mehr zu Migrationen, Einrichtung oder Datum.";
}

/** Vor „mit-daten“: die E2E-Datenbank durch die Vorlage ersetzen, Belege und Sitzung zurücklegen */
export async function abzugEinspielen(): Promise<void> {
  const grund = abzugFehlt();
  if (grund) throw new Error(`${grund} Einmal ohne E2E_ABZUG laufen lassen, etwa \`bun run e2e --project mit-daten\`.`);
  const { url, ziel, vorlage } = namen();
  const admin = verwaltung(url);
  try {
    await kopieren(admin, vorlage, ziel);
  } finally {
    await admin.end();
  }
  // Rechte auf die Datenbank selbst (CONNECT, TEMPORARY) übernimmt die Kopie nicht; die Migration setzt sie wie beim Start
  const migration = spawnSync("bun", ["run", "db:migrate"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: appDatabaseUrlFuer(), MIGRATION_DATABASE_URL: process.env.E2E_APP_DATABASE_URL ? databaseUrlFuer() : "" },
    encoding: "utf8",
  });
  if (migration.status !== 0) throw new Error(`Migration nach dem Einspielen fehlgeschlagen:\n${migration.stdout}${migration.stderr}`);
  rmSync(BELEGE, { recursive: true, force: true });
  if (existsSync(`${ORDNER}belege`)) cpSync(`${ORDNER}belege`, BELEGE, { recursive: true });
  cpSync(`${ORDNER}sitzung.json`, SESSION);
}
