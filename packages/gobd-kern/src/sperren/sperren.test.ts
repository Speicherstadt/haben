import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANWEISUNGSGRENZE, vorlageSql } from "../sql/vorlage.ts";
import { leseMomentaufnahme, leseSollbestand, type Sollbestand } from "./bestand.ts";
import { vergleiche } from "./vergleich.ts";
import type { Abfrage, Leser } from "./verbindung.ts";

/*
 * Die Prüfung der Sperren gegen eine eigene, frische Datenbank mit der SQL-Vorlage neben TEST_DATABASE_URL; ohne sie
 * übersprungen. Der Benutzer braucht CREATEDB und, um die Vorgabe replica zu setzen, Superuser-Rechte.
 */
const url = process.env.TEST_DATABASE_URL;
const optionen = { schema: "public", praefix: "probe" };

describe.skipIf(!url)("Sperren gegen einen Sollbestand", () => {
  const name = `gobd_kern_sperren_${randomBytes(4).toString("hex")}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let soll: Sollbestand;

  const leser = (): Leser => ({
    transaktion: (lesen) =>
      sql.begin("isolation level repeatable read read only", (tx) => lesen(((text, werte = []) => tx.unsafe(text, werte as never[])) as Abfrage)) as never,
  });
  const pruefen = async () => vergleiche(soll, await leseMomentaufnahme(leser(), { ...optionen, tabellen: soll.sealedTables }), optionen.schema);

  /** Ändert die Datenbank in einer Transaktion, prüft darin und rollt danach zurück */
  async function pruefenZurueckgerollt(aendern: (tx: postgres.TransactionSql) => Promise<unknown>) {
    const zurueck = new Error("zurückrollen");
    let ergebnis: ReturnType<typeof vergleiche> | undefined;
    await sql
      .begin(async (tx) => {
        await aendern(tx);
        const inTransaktion: Leser = { transaktion: (lesen) => lesen(((text, werte = []) => tx.unsafe(text, werte as never[])) as Abfrage) };
        ergebnis = vergleiche(soll, await leseMomentaufnahme(inTransaktion, { ...optionen, tabellen: soll.sealedTables }), optionen.schema);
        throw zurueck;
      })
      .catch((error: unknown) => {
        if (error !== zurueck) throw error;
      });
    return ergebnis!;
  }

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const ziel = new URL(url!);
    ziel.pathname = `/${name}`;
    sql = postgres(ziel.toString(), { max: 2, onnotice: () => {} });
    for (const anweisung of vorlageSql({ praefix: "probe" }).split(ANWEISUNGSGRENZE)) await sql.unsafe(anweisung);
    await sql.unsafe(`
      CREATE TABLE belege (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), betrag_cent bigint NOT NULL DEFAULT 0, locked_at timestamptz);
      SELECT probe_seal_table('belege', 'locked_at');
    `);
    const versiegelt = (abfrage: Abfrage) =>
      abfrage<{ name: string }>("select format('%I.%I', 'public', table_name) as name from sealed_tables order by 1").then((zeilen) =>
        zeilen.map((zeile) => zeile.name),
      );
    soll = await leseSollbestand(leser(), { ...optionen, tabellen: versiegelt });
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  });

  it("liest Trigger, Funktionen mit eigenem Präfix und Standardwerte versiegelter Tabellen", () => {
    expect(soll.triggers).toContainEqual(expect.objectContaining({ table: "public.belege", function: "public.probe_seal()" }));
    expect(soll.functions.map((fn) => fn.name)).toContain("public.probe_reject_locked()");
    expect(soll.functions.every((fn) => fn.name.startsWith("public.probe_"))).toBe(true);
    expect(soll.sealedTables).toEqual(["public.belege"]);
    expect(soll.defaults).toContainEqual({ table: "public.belege", column: "betrag_cent", expression: "0" });
    expect(soll.builtins.major).toBeGreaterThanOrEqual(18);
  });

  it("meldet nichts, solange die Datenbank dem Sollbestand entspricht", async () => {
    expect(await pruefen()).toEqual({ befunde: [], hinweise: [] });
  });

  it("meldet einen abgeschalteten Trigger", async () => {
    const [trigger] = soll.triggers.filter((t) => t.table === "public.belege");
    await sql.unsafe(`ALTER TABLE belege DISABLE TRIGGER ${trigger!.name}`);
    try {
      expect((await pruefen()).befunde).toEqual([{ art: "trigger-aus", tabelle: "public.belege", trigger: trigger!.name, zustand: "D" }]);
    } finally {
      await sql.unsafe(`ALTER TABLE belege ENABLE TRIGGER ${trigger!.name}`);
    }
  });

  it("meldet einen gelöschten Trigger", async () => {
    const [trigger] = soll.triggers.filter((t) => t.table === "public.belege");
    const { befunde } = await pruefenZurueckgerollt((tx) => tx.unsafe(`DROP TRIGGER ${trigger!.name} ON belege`));
    expect(befunde).toEqual([{ art: "trigger-fehlt", tabelle: "public.belege", trigger: trigger!.name }]);
    expect(await pruefen()).toEqual({ befunde: [], hinweise: [] });
  });

  it("meldet eine geänderte Funktion", async () => {
    const [vorher] = await sql<{ definition: string }[]>`select pg_get_functiondef('probe_append_only'::regproc) as definition`;
    await sql.unsafe(`CREATE OR REPLACE FUNCTION probe_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
    try {
      expect((await pruefen()).befunde).toContainEqual(expect.objectContaining({ art: "funktion-veraendert", funktion: "public.probe_append_only()" }));
    } finally {
      await sql.unsafe(vorher!.definition);
    }
    expect(await pruefen()).toEqual({ befunde: [], hinweise: [] });
  });

  it("meldet Vorgaben replica für Datenbank und Rolle in fester Reihenfolge", async () => {
    const rolle = `probe_replica_${randomBytes(4).toString("hex")}`;
    // ALTER ROLE und ALTER DATABASE sind transaktional: Nach dem Zurückrollen bleibt keine Vorgabe.
    const { befunde } = await pruefenZurueckgerollt(async (tx) => {
      await tx.unsafe(`CREATE ROLE ${rolle} NOLOGIN`);
      await tx.unsafe(`ALTER ROLE ${rolle} IN DATABASE ${name} SET session_replication_role = replica`);
      await tx.unsafe(`ALTER ROLE ${rolle} SET session_replication_role = replica`);
      await tx.unsafe(`ALTER DATABASE ${name} SET session_replication_role = replica`);
    });
    expect(befunde).toEqual([
      { art: "replica", vorgabe: { bereich: "datenbank", datenbank: name } },
      { art: "replica", vorgabe: { bereich: "rolle", rolle, datenbank: null } },
      { art: "replica", vorgabe: { bereich: "rolle", rolle, datenbank: name } },
    ]);
  });

  // Eine Regel schreibt eine Anweisung um, bevor Trigger feuern: ON INSERT … DO INSTEAD NOTHING verwirft etwa jeden Eintrag
  // ins Audit-Log, ohne dass die Kette bricht. Die Regel _RETURN einer Sicht ist deren Abfrage und kein Befund.
  // https://www.postgresql.org/docs/18/rules.html
  it("meldet eine Regel auf einer Tabelle, nicht die Abfrage einer Sicht", async () => {
    const { befunde } = await pruefenZurueckgerollt(async (tx) => {
      await tx.unsafe("CREATE VIEW belege_sicht AS SELECT id FROM belege");
      await tx.unsafe("CREATE RULE verwerfen AS ON INSERT TO belege DO INSTEAD NOTHING");
    });
    expect(befunde).toEqual([{ art: "regel", tabelle: "belege", regel: "verwerfen" }]);
    expect(await pruefen()).toEqual({ befunde: [], hinweise: [] });
  });

  // Ein zusätzlicher Trigger auf audit_log oder audit_chain kann Einträge verwerfen oder vor dem Hashen ändern; auf anderen
  // Tabellen bleibt er ein Hinweis.
  it("meldet einen zusätzlichen Trigger auf dem Audit-Log als Befund, auf einer anderen Tabelle als Hinweis", async () => {
    const { befunde, hinweise } = await pruefenZurueckgerollt(async (tx) => {
      await tx.unsafe("CREATE FUNCTION fremd_verwerfen() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");
      await tx.unsafe("CREATE TRIGGER audit_log_a BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fremd_verwerfen()");
      await tx.unsafe("CREATE TRIGGER audit_chain_a BEFORE UPDATE ON audit_chain FOR EACH ROW EXECUTE FUNCTION fremd_verwerfen()");
      await tx.unsafe("CREATE TRIGGER belege_a BEFORE INSERT ON belege FOR EACH ROW EXECUTE FUNCTION fremd_verwerfen()");
    });
    expect(befunde).toEqual([
      { art: "trigger-am-audit-log", tabelle: "public.audit_chain", trigger: "audit_chain_a" },
      { art: "trigger-am-audit-log", tabelle: "public.audit_log", trigger: "audit_log_a" },
    ]);
    expect(hinweise.filter((hinweis) => hinweis.art === "trigger-zusaetzlich")).toEqual([
      { art: "trigger-zusaetzlich", tabelle: "public.belege", trigger: "belege_a" },
    ]);
    expect(await pruefen()).toEqual({ befunde: [], hinweise: [] });
  });

  // Der Kern liest Trigger mit format('%I.%I'); ein Schema mit Großbuchstaben steht dabei in Anführungszeichen.
  it("erkennt einen zusätzlichen Trigger auf dem Audit-Log auch in einem Schema, das Anführungszeichen braucht", async () => {
    const zurueck = new Error("zurückrollen");
    const kern = { schema: "Kern", praefix: "kern" };
    await sql
      .begin(async (tx) => {
        await tx.unsafe('CREATE SCHEMA "Kern"');
        await tx.unsafe('CREATE TABLE "Kern".audit_log (id int)');
        const inTransaktion: Leser = { transaktion: (lesen) => lesen(((text, werte = []) => tx.unsafe(text, werte as never[])) as Abfrage) };
        const sollKern = (await leseMomentaufnahme(inTransaktion, { ...kern, tabellen: [] })).bestand;
        await tx.unsafe("CREATE FUNCTION fremd_verwerfen() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");
        await tx.unsafe('CREATE TRIGGER x BEFORE INSERT ON "Kern".audit_log FOR EACH ROW EXECUTE FUNCTION public.fremd_verwerfen()');
        const { befunde, hinweise } = vergleiche(sollKern, await leseMomentaufnahme(inTransaktion, { ...kern, tabellen: [] }), kern.schema);
        expect(befunde.filter((befund) => befund.art === "trigger-am-audit-log")).toEqual([
          { art: "trigger-am-audit-log", tabelle: '"Kern".audit_log', trigger: "x" },
        ]);
        expect(hinweise.filter((hinweis) => hinweis.art === "trigger-zusaetzlich")).toEqual([]);
        throw zurueck;
      })
      .catch((error: unknown) => {
        if (error !== zurueck) throw error;
      });
  });

  // Zuletzt: Eine während des Tests neu geöffnete Verbindung behält replica als Vorgabe und meldete das auch danach
  it("meldet die dauerhafte Vorgabe replica der Datenbank", async () => {
    await admin.unsafe(`ALTER DATABASE ${name} SET session_replication_role = replica`);
    try {
      expect((await pruefen()).befunde).toContainEqual({ art: "replica", vorgabe: { bereich: "datenbank", datenbank: name } });
    } finally {
      await admin.unsafe(`ALTER DATABASE ${name} RESET session_replication_role`);
    }
  });
});
