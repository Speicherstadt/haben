import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BrowserContext } from "@playwright/test";
import postgres from "postgres";
import { currentDay, SESSION } from "./daten.ts";
import { appDatabaseUrlFuer, type Durchlauf, databaseUrlFuer } from "./durchlaeufe.ts";

/**
 * Abzug einer Einrichtung (#1742): die Datenbank als Vorlage daneben (CREATE DATABASE … TEMPLATE), dazu die Belegdateien
 * und die Sitzung. Ohne Durchlauf der Stand nach app.spec.ts: „mit-daten“ beginnt mit dem Einspielen statt mit der
 * Einrichtung im Browser; mit E2E_ABZUG=1 aus einem früheren Lauf, ohne „ablauf“ (playwright.config.ts). Mit Durchlauf
 * der Stand nach dessen Einrichtung, den jeder seiner Abschnitte (ABZUG_AUS in e2e/durchlaeufe.ts) in die eigene
 * Datenbank einspielt. Eine Vorlagendatenbank braucht kein pg_dump in der Version des Servers, Sichern und Einspielen
 * dauern Sekunden.
 * https://www.postgresql.org/docs/18/manage-ag-templatedbs.html
 */

const WURZEL = fileURLToPath(new URL("../.e2e-abzug/", import.meta.url));
const ordner = (durchlauf?: Durchlauf) => `${WURZEL}${durchlauf ?? "ablauf"}/`;
// Muss zu DOCUMENTS_DIR der Server in playwright.config.ts passen
const belege = (durchlauf?: Durchlauf) => `${process.env.E2E_DOCUMENTS_DIR ?? "test-results/e2e-belege"}${durchlauf ? `-${durchlauf}` : ""}`;

/** Was den Stand bestimmt: Migrationen, die Einrichtung und der Tag, von dem aus die Daten datiert sind */
export function fingerabdruck(durchlauf?: Durchlauf): string {
  const hash = createHash("sha256");
  const drizzle = fileURLToPath(new URL("../drizzle/", import.meta.url));
  for (const datei of readdirSync(drizzle)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    hash.update(readFileSync(drizzle + datei));
  for (const datei of [`${durchlauf ?? "app"}.spec.ts`, "einrichtung.ts", "daten.ts", "abzug.ts"]) hash.update(readFileSync(new URL(datei, import.meta.url)));
  hash.update(currentDay());
  return hash.digest("hex");
}

/** Die Datenbank des Durchlaufs; Name endet wie verlangt auf „e2e“ */
function datenbank(durchlauf?: Durchlauf) {
  const url = new URL(databaseUrlFuer(durchlauf));
  const name = url.pathname.slice(1);
  if (!/e2e$/i.test(name)) throw new Error(`Die E2E-Datenbank muss auf „e2e“ enden, nicht „${name}“.`);
  return { url, name };
}

/** Die Vorlage liegt neben der Datenbank: haben_e2e → haben_abzug_e2e, haben_belege_steuern_e2e → haben_belege_steuern_abzug_e2e */
const vorlageFuer = (durchlauf?: Durchlauf) => datenbank(durchlauf).name.replace(/e2e$/i, "abzug_e2e");

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
      // 55006 object_in_use: eine Verbindung zur Quelle kam zwischen Trennen und Kopieren wieder, oder ein anderer
      // Abschnitt kopiert gerade dieselbe Vorlage
      if ((error as { code?: string }).code !== "55006" || versuch === 50) throw error;
      await new Promise((weiter) => setTimeout(weiter, 100));
    }
  }
}

const verwaltung = (url: URL) => postgres(Object.assign(new URL(url), { pathname: "/postgres" }).toString(), { max: 1, onnotice: () => {} });

/**
 * Datenbank, Belege und Sitzung sichern: ohne Durchlauf nach app.spec.ts (Sitzung aus SESSION), mit Durchlauf nach dessen
 * Einrichtung (Sitzung aus `context`)
 */
export async function abzugSichern(durchlauf?: Durchlauf, context?: BrowserContext): Promise<void> {
  const { url, name } = datenbank(durchlauf);
  const admin = verwaltung(url);
  try {
    await kopieren(admin, name, vorlageFuer(durchlauf));
  } finally {
    await admin.end();
  }
  const ziel = ordner(durchlauf);
  rmSync(ziel, { recursive: true, force: true });
  mkdirSync(ziel, { recursive: true });
  if (existsSync(belege(durchlauf))) cpSync(belege(durchlauf), `${ziel}belege`, { recursive: true });
  if (context) await context.storageState({ path: `${ziel}sitzung.json` });
  else cpSync(SESSION, `${ziel}sitzung.json`);
  writeFileSync(`${ziel}info.json`, JSON.stringify({ fingerabdruck: fingerabdruck(durchlauf) }));
}

/** Warum es keinen passenden Abzug gibt, oder null */
export function abzugFehlt(durchlauf?: Durchlauf): string | null {
  const info = `${ordner(durchlauf)}info.json`;
  if (!existsSync(info)) return "Es gibt noch keinen Abzug.";
  const { fingerabdruck: gesichert } = JSON.parse(readFileSync(info, "utf8")) as { fingerabdruck: string };
  return gesichert === fingerabdruck(durchlauf) ? null : "Der Abzug passt nicht mehr zu Migrationen, Einrichtung oder Datum.";
}

/**
 * Den Abzug von `quelle` in die Datenbank von `ziel` einspielen und die Belege in dessen DOCUMENTS_DIR legen. Ohne Durchlauf
 * (vor „mit-daten“) liegt die Sitzung danach in SESSION; mit Durchlauf gibt die Funktion den Pfad der Sitzung für
 * browser.newContext({ storageState }) zurück. Ein Cookie für localhost gilt an jedem Port, die Sitzung steht in der Kopie.
 */
export async function abzugEinspielen(quelle?: Durchlauf, ziel: Durchlauf | undefined = quelle): Promise<string> {
  const grund = abzugFehlt(quelle);
  if (grund) throw new Error(`${grund} Einmal ohne E2E_ABZUG laufen lassen, etwa \`bun run e2e --project mit-daten\`.`);
  const { url, name } = datenbank(ziel);
  const admin = verwaltung(url);
  try {
    await kopieren(admin, vorlageFuer(quelle), name);
  } finally {
    await admin.end();
  }
  // Rechte auf die Datenbank selbst (CONNECT, TEMPORARY) übernimmt die Kopie nicht; die Migration setzt sie wie beim Start
  const migration = spawnSync("bun", ["run", "db:migrate"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: appDatabaseUrlFuer(ziel), MIGRATION_DATABASE_URL: process.env.E2E_APP_DATABASE_URL ? databaseUrlFuer(ziel) : "" },
    encoding: "utf8",
  });
  if (migration.status !== 0) throw new Error(`Migration nach dem Einspielen fehlgeschlagen:\n${migration.stdout}${migration.stderr}`);
  const von = ordner(quelle);
  rmSync(belege(ziel), { recursive: true, force: true });
  if (existsSync(`${von}belege`)) cpSync(`${von}belege`, belege(ziel), { recursive: true });
  if (quelle) return `${von}sitzung.json`;
  cpSync(`${von}sitzung.json`, SESSION);
  return SESSION;
}
