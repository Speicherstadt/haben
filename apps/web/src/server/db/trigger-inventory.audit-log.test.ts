import { sql as query } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../test-db.ts";
import { checkTriggerIntegrity } from "./trigger-inventory.ts";

/*
 * Am Audit-Log vorbei, ohne dass die Kette bricht. Regeln (CREATE RULE): Der Eigentümer einer Tabelle kann jede Anweisung
 * darauf umschreiben, bevor ein Trigger feuert; `ON INSERT TO audit_log DO INSTEAD NOTHING` verwirft jeden Eintrag, und weil
 * dann auch kein Trigger auf audit_log läuft, bleiben Kette und Kopf in sich stimmig. Haben selbst legt keine Regeln an.
 * Zusätzliche Trigger: BEFORE-Trigger einer Tabelle feuern in der Reihenfolge ihrer Namen; einer vor audit_log_chain kann
 * den Eintrag verwerfen oder ändern, bevor er gehasht wird. Standardwerte: Die Zeitpunkte von Einträgen und Siegeln setzen
 * haben_audit_chain und haben_seal selbst; ein geänderter Standardwert wirkt nicht und ist ein Befund.
 * https://www.postgresql.org/docs/18/rules-update.html  https://www.postgresql.org/docs/18/trigger-definition.html
 */
describe.skipIf(!testDatabaseUrl)("Regeln und Trigger am Audit-Log (Postgres)", () => {
  let sql: postgres.Sql;
  beforeAll(async () => {
    sql = await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await sql?.end();
  });

  async function rolledBack(check: (tx: ReturnType<typeof drizzle>) => Promise<void>) {
    const rollback = new Error("Gegenprobe zurückrollen");
    try {
      await drizzle(sql).transaction(async (tx) => {
        await check(tx as unknown as ReturnType<typeof drizzle>);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  const befund = (tabelle: string, text: string) => ({ art: "sperre", tabelle, zeile: null, seq: null, befund: text });

  it("meldet eine Regel, die Einträge ins Audit-Log verwirft, obwohl Kette und Siegel stimmen", async () => {
    await rolledBack(async (tx) => {
      expect((await checkTriggerIntegrity(tx)).problems).toEqual([]);
      const [{ seq: vorher }] = (await tx.execute(query`select seq from audit_chain`)) as unknown as [{ seq: string }];
      await tx.execute(query.raw("create rule verwerfen as on insert to public.audit_log do instead nothing"));
      await tx.execute(query`insert into company (id, name) values (1, 'Probe') on conflict (id) do update set name = 'Probe geändert'`);
      await tx.execute(query`set constraints all immediate`);
      // Die Änderung an der Firma steht nicht im Audit-Log, die Kette meldet nichts.
      expect(await tx.execute(query`select seq from audit_chain`)).toEqual([{ seq: vorher }]);
      expect(await tx.execute(query`select art, tabelle, befund from haben_integrity_problems()`)).toEqual([]);
      expect((await checkTriggerIntegrity(tx)).problems).toEqual([befund("audit_log", "Regel verwerfen auf audit_log angelegt")]);
      // Sonst behält die Verbindung nach dem Zurückrollen den Plan von haben_audit mit der Regel und verwirft auch in späteren
      // Tests jeden Eintrag; DROP RULE vor dem Zurückrollen reicht nicht (ausprobiert mit PostgreSQL 19.0).
      await tx.execute(query`discard plans`);
    });
  });

  async function letzterEintrag(tx: ReturnType<typeof drizzle>) {
    const [kopf] = (await tx.execute(query`select seq from audit_chain`)) as unknown as [{ seq: string }];
    return kopf.seq;
  }

  const zusaetzlich = befund("audit_log", "Zusätzlicher Trigger public.audit_log.audit_log_a auf dem Audit-Log");

  it("meldet einen zusätzlichen Trigger, der Einträge ins Audit-Log verwirft (RETURN NULL)", async () => {
    await rolledBack(async (tx) => {
      const vorher = await letzterEintrag(tx);
      await tx.execute(query.raw("create function fremd_verwerfen() returns trigger language plpgsql as $$ begin return null; end $$"));
      await tx.execute(query.raw("create trigger audit_log_a before insert on public.audit_log for each row execute function fremd_verwerfen()"));
      await tx.execute(query`insert into company (id, name) values (1, 'Probe') on conflict (id) do update set name = 'Probe geändert'`);
      await tx.execute(query`set constraints all immediate`);
      expect(await letzterEintrag(tx)).toBe(vorher);
      expect(await tx.execute(query`select art, tabelle, befund from haben_integrity_problems()`)).toEqual([]);
      expect((await checkTriggerIntegrity(tx)).problems).toEqual([zusaetzlich]);
    });
  });

  it("meldet einen zusätzlichen Trigger, der einen Eintrag vor dem Hashen ändert (NEW)", async () => {
    await rolledBack(async (tx) => {
      await tx.execute(
        query.raw(`create function fremd_aendern() returns trigger language plpgsql as $$
          begin NEW.new_value := '{"name": "Gefälscht"}'::jsonb; return NEW; end $$`),
      );
      await tx.execute(query.raw("create trigger audit_log_a before insert on public.audit_log for each row execute function fremd_aendern()"));
      await tx.execute(query`insert into company (id, name) values (1, 'Probe') on conflict (id) do update set name = 'Probe geändert'`);
      await tx.execute(query`set constraints all immediate`);
      expect(await tx.execute(query`select new_value from audit_log order by seq desc limit 1`)).toEqual([{ new_value: { name: "Gefälscht" } }]);
      expect(await tx.execute(query`select art, tabelle, befund from haben_integrity_problems()`)).toEqual([]);
      expect((await checkTriggerIntegrity(tx)).problems).toEqual([zusaetzlich]);
    });
  });

  it("datiert keinen Eintrag über den Standardwert von audit_log.at zurück und meldet dessen Änderung", async () => {
    await rolledBack(async (tx) => {
      await tx.execute(query.raw("alter table public.audit_log alter column at set default '2020-01-01 00:00:00+00'"));
      await tx.execute(query`insert into company (id, name) values (1, 'Probe') on conflict (id) do update set name = 'Probe geändert'`);
      await tx.execute(query`set constraints all immediate`);
      expect(await tx.execute(query`select at = now() as jetzt from audit_log order by seq desc limit 1`)).toEqual([{ jetzt: true }]);
      expect(await tx.execute(query`select art, tabelle, befund from haben_integrity_problems()`)).toEqual([]);
      expect((await checkTriggerIntegrity(tx)).problems).toEqual([befund("audit_log", "Standardwert von audit_log.at wurde verändert")]);
    });
  });

  it("nimmt Zeitpunkt und genesis eines Siegels nicht aus den Standardwerten und meldet deren Änderung", async () => {
    await rolledBack(async (tx) => {
      await tx.execute(
        query.raw("alter table public.seals alter column created_at set default '2020-01-01 00:00:00+00', alter column genesis set default true"),
      );
      const [kasse] = (await tx.execute(
        query`insert into cash_entries (number, date, amount, kind, text) values (900001, '2026-03-01', 100, 'einlage', 'Einlage') returning id`,
      )) as unknown as [{ id: string }];
      expect(await tx.execute(query`select created_at = now() as jetzt, genesis from seals where row_id = ${kasse.id}`)).toEqual([
        { jetzt: true, genesis: false },
      ]);
      expect((await checkTriggerIntegrity(tx)).problems).toEqual([
        befund("seals", "Standardwert von seals.created_at wurde verändert"),
        befund("seals", "Standardwert von seals.genesis wurde verändert"),
      ]);
    });
  });

  it("meldet eine Regel auf einer versiegelten Tabelle", async () => {
    await rolledBack(async (tx) => {
      await tx.execute(query.raw("create rule umleiten as on update to public.vat_returns do instead nothing"));
      expect((await checkTriggerIntegrity(tx)).problems).toEqual([befund("vat_returns", "Regel umleiten auf vat_returns angelegt")]);
    });
  });
});
