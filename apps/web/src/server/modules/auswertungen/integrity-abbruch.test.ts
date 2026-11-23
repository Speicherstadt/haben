import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabaseUrl, workerDocumentsDir } from "../../test-db.ts";

const MIGRATIONS = fileURLToPath(new URL("../../../../drizzle", import.meta.url));
const VORANMELDUNG = "00000000-0000-4000-8000-0000000000f1";

/*
 * Bricht haben_integrity_problems ab, etwa weil sich der Standardwert einer Spalte, die ein älteres Siegel nicht abdeckt,
 * nicht auswerten lässt oder weil die Funktion fehlt, darf weder „Kette prüfen“ mit einem Fehler enden noch die
 * Prüfwert-Mail ausbleiben (#1604). Dafür braucht es ein Siegel aus einem älteren Schemastand: Die Voranmeldung wird auf
 * dem Stand von 0064 festgeschrieben, kz41 kam erst mit 0143 dazu (wie in siegel-altbestand.test.ts).
 */
describe.skipIf(!testDatabaseUrl)("Abgebrochene Prüfung von Kette und Siegeln (Postgres, #1604)", () => {
  let sql: postgres.Sql;
  let integrity: typeof import("./integrity.ts");
  let mail: typeof import("../mail/mail.ts");
  let pruefwertMail: typeof import("./pruefwert-mail.ts");
  const sent: { subject: string; text: string }[] = [];
  const DAY = 24 * 60 * 60 * 1000;
  /** Vormittags in Berlin, so viele Tage ab heute */
  const at = (days: number) => {
    const date = new Date(Date.now() + days * DAY);
    date.setUTCHours(9, 0, 0, 0);
    return date;
  };

  beforeAll(async () => {
    const name = decodeURIComponent(new URL(testDatabaseUrl!).pathname.slice(1));
    const admin = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    await admin`drop database if exists ${admin(name)} with (force)`;
    await admin`create database ${admin(name)}`;
    await admin.end();
    const full = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
    const ordner = mkdtempSync(join(tmpdir(), "haben-migrationen-"));
    cpSync(MIGRATIONS, ordner, { recursive: true });
    const idx = full.entries.findIndex((e: { tag: string }) => e.tag === "0065_hauptbuch_sperren");
    writeFileSync(join(ordner, "meta", "_journal.json"), JSON.stringify({ ...full, entries: full.entries.slice(0, idx) }));
    sql = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(drizzle(sql), { migrationsFolder: ordner });
    await sql`insert into company (id, name, versteuerung) values (1, 'Testfirma', 'ist')`;
    await sql`insert into vat_returns (id, year, month, kz81, kz66, kz83) values (${VORANMELDUNG}, 2025, 3, 10000, 950, 950)`;
    await sql`update vat_returns set status = 'sent', transfer_ticket = 'et1234567890', sent_at = now(), locked_at = now()
      where id = ${VORANMELDUNG}`;
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });

    // Umgebung der App wie setupTestDb, ohne die eben angelegte Datenbank neu zu erzeugen
    Object.assign(process.env, {
      DATABASE_URL: testDatabaseUrl,
      BETTER_AUTH_SECRET: "x".repeat(32),
      BETTER_AUTH_URL: "http://localhost:3000",
      HABEN_ENCRYPTION_KEY: process.env.HABEN_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64"),
      DOCUMENTS_DIR: workerDocumentsDir(),
    });
    integrity = await import("./integrity.ts");
    mail = await import("../mail/mail.ts");
    pruefwertMail = await import("./pruefwert-mail.ts");
    mail.setMailTransportForTests(() => {
      const transport = nodemailer.createTransport({ jsonTransport: true });
      return {
        sendMail: async (message: { subject: string; text: string }) => {
          sent.push(message);
          return transport.sendMail(message);
        },
      } as unknown as ReturnType<typeof nodemailer.createTransport>;
    });
    await mail.saveMailSettings("test", {
      host: "smtp.example.com",
      port: 465,
      secure: true,
      username: "max",
      password: "geheim",
      fromAddress: "haben@example.com",
      reminderTo: "max@example.com",
      remindersEnabled: false,
      reminderDays: [],
    });
  }, 180_000);

  afterAll(async () => {
    await sql?.end();
  });

  const unauswertbar = /Standardwert von vat_returns\.kz41 lässt sich nicht auswerten: division by zero/;

  it("Standardwert, der sich nicht auswerten lässt: Befund an der Spalte, die Prüfung läuft durch (#1716)", async () => {
    expect((await integrity.checkIntegrity()).problems).toEqual([]);
    await sql`alter table vat_returns alter kz41 set default (1/0)`;
    // Die Prüffunktion selbst meldet die Spalte und bricht nicht ab; die übrigen Siegel bleiben ohne Befund
    const befunde = await sql<{ art: string; tabelle: string; befund: string }[]>`select art, tabelle, befund from haben_integrity_problems()`;
    expect(befunde).toEqual([{ art: "sperre", tabelle: "vat_returns", befund: expect.stringMatching(unauswertbar) }]);
    const report = await integrity.checkIntegrity();
    expect(report.problems).toContainEqual(expect.objectContaining({ art: "sperre", tabelle: "vat_returns", befund: expect.stringMatching(unauswertbar) }));
    expect(report.problems.filter((p) => p.tabelle === "haben_integrity_problems" || p.art === "siegel")).toEqual([]);
    // Der Vergleich mit dem Sollbestand (#1591) meldet den geänderten Standardwert weiter
    expect(report.problems.some((p) => p.art === "sperre" && p.tabelle !== "haben_integrity_problems" && /kz41/.test(`${p.tabelle} ${p.befund}`))).toBe(true);
    // Kopf und Anzahlen aus derselben Transaktion kommen trotzdem
    expect(report.head?.seq).toBeGreaterThan(0);
    // „Vergleichen“ mit dem richtigen Prüfwert: unbestätigt, weil der Sollbestand abweicht, keine Ausnahme
    expect(await integrity.checkPruefwert(report.head!.seq, report.head!.hash)).toMatchObject({ status: "unbestaetigt" });
  }, 60_000);

  it("die Prüfwert-Mail geht hinaus und nennt den nicht auswertbaren Standardwert und den Befund des Sollbestands", async () => {
    const result = await pruefwertMail.runDuePruefwertMail(at(1));
    expect(result).toMatchObject({ problems: expect.any(Number) });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/^Haben: Änderungsprotokoll mit Befunden/);
    expect(sent[0]!.text).toMatch(unauswertbar);
    expect(sent[0]!.text).toMatch(/kz41/);
  }, 60_000);

  it("geänderter Wert hinter dem nicht auswertbaren Standardwert: Befunde bleiben, nach dem Zurücksetzen meldet das Siegel ihn", async () => {
    // Direkt an den Sperren vorbei, ohne Eintrag im Audit-Log: Den Wert prüft das ältere Siegel nur am Standardwert
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update vat_returns set kz41 = 4711 where id = ${VORANMELDUNG}`;
    });
    const report = await integrity.checkIntegrity();
    expect(report.problems).toContainEqual(expect.objectContaining({ art: "sperre", tabelle: "vat_returns", befund: expect.stringMatching(unauswertbar) }));
    expect(report.problems.some((p) => p.art === "sperre" && /kz41/.test(p.befund) && !unauswertbar.test(p.befund))).toBe(true);
    // Den gemeldeten Standardwert auf den aus den Migrationen zurückgesetzt: Jetzt fällt der geänderte Wert auf
    await sql`alter table vat_returns alter kz41 set default 0`;
    expect((await integrity.checkIntegrity()).problems).toEqual([
      expect.objectContaining({
        art: "siegel",
        tabelle: "vat_returns",
        zeile: VORANMELDUNG,
        befund: "Spalte vat_returns.kz41 geändert, die das Siegel nicht abdeckt",
      }),
    ]);
  }, 60_000);

  it("gelöschte Prüffunktion: Befund statt Ausnahme, die Mail nennt ihn", async () => {
    await sql`alter table vat_returns alter kz41 set default 0`;
    await sql`drop function haben_integrity_problems(integer)`;
    const report = await integrity.checkIntegrity();
    expect(report.problems).toContainEqual(
      expect.objectContaining({
        tabelle: "haben_integrity_problems",
        befund: expect.stringMatching(/Prüfung von Kette und Siegeln abgebrochen: .*haben_integrity_problems/),
      }),
    );
    await pruefwertMail.runDuePruefwertMail(at(9));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toMatch(/Prüfung von Kette und Siegeln abgebrochen/);
    // „Vergleichen“ ohne Prüffunktion: unbestätigt mit dem Abbruch, nie „ok“ und keine Ausnahme (#1716)
    const head = (await integrity.chainHead())!;
    const vergleich = await integrity.checkPruefwert(head.seq, head.hash);
    expect(vergleich).toMatchObject({ status: "unbestaetigt" });
    expect(vergleich.status === "unbestaetigt" && vergleich.befunde.some((b) => /Prüfung von Kette und Siegeln abgebrochen/.test(b))).toBe(true);
  }, 60_000);

  it("scheitert die Prüfung ganz, geht die Mail trotzdem hinaus und nennt den Fehler", async () => {
    // Kopf vor dem Versand: Die Mail schreibt selbst einen Eintrag ins Protokoll
    const [head] = await sql`select seq, encode(hash, 'hex') as hash from audit_chain`;
    const result = await pruefwertMail.runDuePruefwertMail(at(17), async () => {
      throw new Error("Abgleich nicht lesbar");
    });
    expect(result).toMatchObject({ failed: true });
    expect(sent).toHaveLength(3);
    expect(sent[2]!.subject).toMatch(/^Haben: Änderungsprotokoll mit Befunden/);
    expect(sent[2]!.text).toContain("Die Prüfung ist fehlgeschlagen: Abgleich nicht lesbar.");
    // Der Prüfwert steht trotzdem in der Mail
    expect(sent[2]!.text).toContain(`Nr. ${head!.seq} · ${head!.hash}`);
  }, 60_000);

  it("scheitert die Prüfung ganz, steht der Fehler im Log, auf das die Mail verweist", async () => {
    const fehler = new Error("Abgleich nicht lesbar");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await pruefwertMail.runDuePruefwertMail(at(25), async () => {
        throw fehler;
      });
      expect(sent).toHaveLength(4);
      expect(sent[3]!.text).toContain("Bitte im Log von Haben nachsehen.");
      expect(log.mock.calls.some((args) => args.includes(fehler))).toBe(true);
    } finally {
      log.mockRestore();
    }
  }, 60_000);
});
