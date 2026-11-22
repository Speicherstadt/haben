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
    const zurueck = new Error("zurückrollen");
    // Gelöscht und geprüft in einer Transaktion, die danach zurückrollt
    await sql
      .begin(async (tx) => {
        await tx.unsafe(`DROP TRIGGER ${trigger!.name} ON belege`);
        const inTransaktion: Leser = { transaktion: (lesen) => lesen(((text, werte = []) => tx.unsafe(text, werte as never[])) as Abfrage) };
        const ist = await leseMomentaufnahme(inTransaktion, { ...optionen, tabellen: soll.sealedTables });
        expect(vergleiche(soll, ist, optionen.schema).befunde).toEqual([{ art: "trigger-fehlt", tabelle: "public.belege", trigger: trigger!.name }]);
        throw zurueck;
      })
      .catch((error: unknown) => {
        if (error !== zurueck) throw error;
      });
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
    const zurueck = new Error("zurückrollen");
    // ALTER ROLE und ALTER DATABASE sind transaktional: Nach dem Zurückrollen bleibt keine Vorgabe.
    await sql
      .begin(async (tx) => {
        await tx.unsafe(`CREATE ROLE ${rolle} NOLOGIN`);
        await tx.unsafe(`ALTER ROLE ${rolle} IN DATABASE ${name} SET session_replication_role = replica`);
        await tx.unsafe(`ALTER ROLE ${rolle} SET session_replication_role = replica`);
        await tx.unsafe(`ALTER DATABASE ${name} SET session_replication_role = replica`);
        const inTransaktion: Leser = { transaktion: (lesen) => lesen(((text, werte = []) => tx.unsafe(text, werte as never[])) as Abfrage) };
        const ist = await leseMomentaufnahme(inTransaktion, { ...optionen, tabellen: soll.sealedTables });
        expect(vergleiche(soll, ist, optionen.schema).befunde).toEqual([
          { art: "replica", vorgabe: { bereich: "datenbank", datenbank: name } },
          { art: "replica", vorgabe: { bereich: "rolle", rolle, datenbank: null } },
          { art: "replica", vorgabe: { bereich: "rolle", rolle, datenbank: name } },
        ]);
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
