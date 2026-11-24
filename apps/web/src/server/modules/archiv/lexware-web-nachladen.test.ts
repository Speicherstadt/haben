import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";

const voucher = JSON.parse(
  readFileSync(new URL("../../../../../../packages/import/test-fixtures/lexoffice-web/purchase-gross.json", import.meta.url), "utf8"),
) as { list: { entityId: string } };
const filename = "2025-4711.pdf";
const path = `dateien/${voucher.list.entityId}/1-${filename}`;
const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(JSON.stringify(value));

function backup(withAttachment: boolean) {
  return {
    name: "lexware-sicherung-2026-11-02-teil-01.zip",
    bytes: zipSync({
      "manifest.json": json({ format: "haben-lexware-web", version: 2, part: 1, createdAt: "2026-11-02T10:00:00.000Z" }),
      "kontakte.json": json([]),
      [`belege/${voucher.list.entityId}.json`]: json({ ...voucher, files: [{ path, role: "anhang", filename, mimeType: "application/pdf" }] }),
      ...(withAttachment ? { [path]: encoder.encode("%PDF-1.4\n% Beleg\n%%EOF\n") } : {}),
    }),
  };
}

describe.skipIf(!testDatabaseUrl)("Lexware-Sicherung mit fehlender Datei (Postgres)", () => {
  let sql: postgres.Sql;
  let lexoffice: typeof import("./lexoffice.ts") & typeof import("./umzug-abgleich.ts") & typeof import("./umzug-belege.ts");
  let legacy: typeof import("./legacy-open.ts");
  let dateistand: typeof import("./dateistand.ts");

  beforeAll(async () => {
    sql = await setupTestDb();
    lexoffice = { ...(await import("./lexoffice.ts")), ...(await import("./umzug-abgleich.ts")), ...(await import("./umzug-belege.ts")) };
    legacy = await import("./legacy-open.ts");
    dateistand = await import("./dateistand.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  it("behält den Beleg und schließt seinen Dateistand nach dem Upload einer vollständigen Sicherung", async () => {
    const actor = "test-user";
    const voucherRows = () => sql`select id, number, gross, raw->>'quelle' as quelle from lexoffice_vouchers where lexoffice_id = ${voucher.list.entityId}`;
    const year = async () => (await lexoffice.reconciliation()).years.find((entry) => entry.year === 2025);
    const initialId = await lexoffice.startWebImport(actor, [backup(false)], { wait: true });

    expect(await lexoffice.latestImport()).toMatchObject({ id: initialId, status: "fertig", progress: { listed: 1, imported: 1, files: 0, failed: [] } });
    const initial = await voucherRows();
    expect(initial).toEqual([{ id: expect.any(String), number: "2025-4711", gross: 13090, quelle: "lexware-web" }]);
    const id = initial[0]!.id as string;
    const detail = () => lexoffice.legacyVoucherDetail(id);
    expect(await detail()).toMatchObject({
      files: [],
      fileState: {
        status: "abruf_fehlgeschlagen",
        reloadIssue: "Datei fehlt in der Sicherung. Eine neue Sicherung mit der fehlenden Datei importieren.",
        history: [{ state: "abruf_fehlgeschlagen", role: "anhang", sourceFileId: path }],
      },
    });
    // Offene Posten und „ohne Datei bestätigen“ lesen die Herkunft aus der Archivzeile, nicht aus der Belegansicht
    const [posten] = (await legacy.openLegacyItems("2025-12-31")).filter((item) => item.number === "2025-4711");
    expect(posten!.blocker).toBe("Datei fehlt in der Sicherung. Eine neue Sicherung mit der fehlenden Datei importieren.");
    await expect(dateistand.confirmWithoutFile(actor, id, "")).rejects.toThrow(
      "Datei fehlt in der Sicherung. Eine neue Sicherung mit der fehlenden Datei importieren.",
    );
    expect(await year()).toMatchObject({
      withoutFile: 1,
      files: { abrufFehlgeschlagen: 1 },
      checks: expect.arrayContaining([{ label: "Jeder Beleg hat eine Datei", ok: false, detail: "1 Abruf fehlgeschlagen" }]),
    });

    const complete = backup(true);
    const retryId = await lexoffice.startWebImport(actor, [complete], { wait: true });

    expect.soft(await lexoffice.latestImport()).toMatchObject({
      id: retryId,
      status: "fertig",
      progress: { imported: 0, nachgeladen: 1, files: 1, failed: [] },
    });
    expect(await voucherRows()).toEqual(initial);
    const recovered = await detail();
    expect(recovered).toMatchObject({
      files: [{ filename, role: "anhang", lexofficeFileId: path, reloadedAt: expect.any(Date) }],
      fileState: {
        status: "vollstaendig",
        reloadIssue: null,
        history: [
          { state: "abruf_fehlgeschlagen", role: "anhang", sourceFileId: path },
          { state: "nachgeladen", role: "anhang", sourceFileId: path },
        ],
      },
    });
    expect(await year()).toMatchObject({
      withoutFile: 0,
      files: { abrufFehlgeschlagen: 0 },
      checks: expect.arrayContaining([expect.objectContaining({ label: "Jeder Beleg hat eine Datei", ok: true })]),
    });

    await lexoffice.startWebImport(actor, [complete], { wait: true });

    expect(await lexoffice.latestImport()).toMatchObject({ status: "fertig", progress: { imported: 0, skipped: 1, files: 0, failed: [] } });
    expect(await detail()).toEqual(recovered);
  });
});
