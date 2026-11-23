import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { FASTBILL_LIST_MARKER as LIST_MARKER } from "../../../lib/fastbill-skript.ts";
import { fakeBrowser, runInConsole } from "./test-browser-skript.ts";

/*
 * Das echte Browser-Skript aus apps/web/public mit der Liste der wartenden Ausgaben, wie Haben sie einsetzt, gegen
 * nachgebaute Antworten von my.fastbill.com; seine ZIP-Teile gehen durch uploadFastbillReceipts in die Datenbank.
 */

const SCRIPT = readFileSync(new URL("../../../../public/fastbill-belege.js", import.meta.url), "utf8");
/** Grenze eines ZIP-Teils im Skript (PART_LIMIT) */
const PART_LIMIT = 50 * 1024 * 1024;
const HOST = "https://my.fastbill.com";

const PDF = new TextEncoder().encode("%PDF-1.4\n% Beleg Bürobedarf\n%%EOF\n");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
/** Ein PDF mit `size` Bytes, für die Teilgrenze */
const bigPdf = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set(PDF);
  return bytes;
};
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const file = (bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string>) => new Response(bytes, { headers });
const status = (code: number) => new Response("", { status: code });

/** Antworten je Pfad unter /download/; ein Array gilt der Reihe nach je Versuch, der letzte Eintrag bleibt */
type Answers = Record<string, (() => Response) | (() => Response)[]>;

/** Nachgebautes my.fastbill.com; `asked` sammelt die abgerufenen Pfade samt credentials */
function fakeFastbill(answers: Answers, asked: { path: string; credentials?: RequestCredentials }[]) {
  const tries = new Map<string, number>();
  return async (input: URL | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    asked.push({ path: url.pathname, credentials: init?.credentials });
    const attempt = tries.get(url.pathname) ?? 0;
    tries.set(url.pathname, attempt + 1);
    const answer = answers[url.pathname.replace("/download/", "")];
    if (!answer) return status(404);
    return Array.isArray(answer) ? answer[Math.min(attempt, answer.length - 1)]!() : answer();
  };
}

/** Führt das Skript mit eingesetzter Liste aus wie in der Konsole; gibt Downloads, Wartezeiten und Meldungen zurück */
async function runScript(list: { id: string; url: string }[] | null, fetchFn: ReturnType<typeof fakeFastbill>, hostname = "my.fastbill.com") {
  expect(SCRIPT).toMatch(LIST_MARKER);
  const withList = list ? SCRIPT.replace(LIST_MARKER, JSON.stringify(list)) : SCRIPT;
  // Das Skript wartet nicht auf seinen Ablauf; zurückgegeben wird er, damit der Test ihn abwarten kann
  const source = withList.replace("(async (LISTE) =>", "return (async (LISTE) =>");
  expect(source).not.toBe(withList);
  const browser = fakeBrowser();
  const logs: string[] = [];
  const logger = { log: (...args: unknown[]) => logs.push(args.slice(1).join(" ")) };
  const location = { hostname, host: hostname };
  await runInConsole(source, { ...browser.globals, location, fetch: fetchFn, console: logger });
  return { parts: await browser.downloads(), waits: browser.waits, logs };
}

const unzip = (bytes: Uint8Array) => {
  const entries = unzipSync(bytes);
  return { files: Object.keys(entries).sort(), entries, manifest: JSON.parse(new TextDecoder().decode(entries["manifest.json"])) };
};

describe.skipIf(!testDatabaseUrl)("Browser-Skript für FastBill-Belege (Postgres)", () => {
  let receipts: typeof import("./fastbill-belege.ts");
  let sql: postgres.Sql;
  const actor = "test-user";

  /** Merkt Ausgaben als wartend vor wie der Abruf und gibt die Liste zurück, die Haben ins Skript einsetzt */
  async function waiting(urls: Record<string, string>) {
    for (const [id, url] of Object.entries(urls)) {
      await receipts.waitingReceipt(actor, id, { number: "", date: "2024-02-15", contactName: "Software Beispiel", gross: 595 }, url);
    }
    return receipts.fastbillReceiptScriptList();
  }

  beforeAll(async () => {
    sql = await setupTestDb();
    receipts = await import("./fastbill-belege.ts");
  }, 30_000);

  beforeEach(async () => {
    await sql`delete from fastbill_receipts`;
  });

  afterAll(async () => {
    await sql?.end();
  });

  it("lädt PDF und Bild, wiederholt bei 429 und 503, nennt die Ausgaben ohne Datei im Manifest; der Upload legt die Dateien an ihre Ausgaben", async () => {
    const list = await waiting({
      "1001": `${HOST}/download/1001`,
      "1002": `${HOST}/download/1002`,
      "1003": `${HOST}/download/1003`,
      "1004": `${HOST}/download/1004`,
      "1005": `${HOST}/download/1005`,
      "1006": `${HOST}/download/1006`,
      "1007": "https://cdn.example.com/download/1007",
    });
    const asked: { path: string; credentials?: RequestCredentials }[] = [];
    const fetchFn = fakeFastbill(
      {
        "1001": () => file(PDF, { "content-type": "application/pdf; charset=binary" }),
        // Abgemeldet: FastBill antwortet mit der Anmeldeseite
        "1002": () => file(new TextEncoder().encode("<!DOCTYPE html><title>Login</title>"), { "content-type": "text/html; charset=UTF-8" }),
        // Ohne passende Art gilt die Endung aus dem Dateinamen
        "1003": () => file(JPEG, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="Scan Tankstelle.JPG"' }),
        // 1004 fehlt: 404
        "1005": [() => status(429), () => status(503), () => file(PDF, { "content-type": "application/pdf" })],
        "1006": () => file(new Uint8Array(), { "content-type": "application/pdf" }),
      },
      asked,
    );
    const { parts, waits, logs } = await runScript(list, fetchFn);

    // Mit Anmeldung, je Datei eine Pause; 1005 zweimal mit wachsender Wartezeit wiederholt; die fremde Adresse nie gefragt
    expect(asked.every((a) => a.credentials === "include")).toBe(true);
    expect(asked.map((a) => a.path)).toEqual(["1001", "1002", "1003", "1004", "1005", "1005", "1005", "1006"].map((id) => `/download/${id}`));
    expect(waits).toEqual([150, 150, 150, 150, 150, 1000, 150, 2000, 150, 150, 60_000]);
    expect(logs).toContain("Fertig: 3 Belege in 1 ZIP-Datei(en).");

    expect(parts.map((p) => p.name)).toEqual([expect.stringMatching(/^fastbill-belege-\d{4}-\d{2}-\d{2}-teil-1\.zip$/)]);
    const zip = unzip(parts[0]!.bytes);
    expect(zip.files).toEqual(["belege/1001.pdf", "belege/1003.jpg", "belege/1005.pdf", "manifest.json"]);
    expect(zip.manifest).toEqual({
      format: "haben-fastbill-belege",
      version: 1,
      part: 1,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      count: 3,
      missing: ["1002", "1004", "1006", "1007"],
    });

    expect(await receipts.uploadFastbillReceipts(actor, parts[0]!.bytes)).toEqual({ accepted: 3, unknown: 0, invalid: [] });
    expect((await receipts.fastbillReceiptsOverview()).map((r) => [r.expenseId, r.status, r.filename])).toEqual([
      ["1001", "datei", "1001.pdf"],
      ["1002", "wartet", null],
      ["1003", "datei", "1003.jpg"],
      ["1004", "wartet", null],
      ["1005", "datei", "1005.pdf"],
      ["1006", "wartet", null],
      ["1007", "wartet", null],
    ]);
    const stored = await sql`select expense_id, sha256, mime_type from fastbill_receipts where status = 'datei' order by expense_id`;
    expect(stored.map((r) => [r.expense_id, r.sha256, r.mime_type])).toEqual([
      ["1001", sha256(PDF), "application/pdf"],
      ["1003", sha256(JPEG), "image/jpeg"],
      ["1005", sha256(PDF), "application/pdf"],
    ]);
  });

  it("beginnt einen neuen Teil erst, wenn eine Datei über 50 MB hinausginge; jedes Manifest nennt die Ausgaben ohne Datei", async () => {
    const list = await waiting({
      "2001": `${HOST}/download/2001`,
      "2002": `${HOST}/download/2002`,
      "2003": `${HOST}/download/2003`,
      "2004": `${HOST}/download/2004`,
    });
    // 2003 füllt den ersten Teil genau bis zur Grenze: Eintrag 2002 (Kopf mit 30 Bytes und Name, Datei) und Datei 2003
    const first = bigPdf(20 * 1024 * 1024);
    const second = bigPdf(PART_LIMIT - (30 + "belege/2002.pdf".length + first.length));
    const pdf = { "content-type": "application/pdf" };
    const fetchFn = fakeFastbill({ "2002": () => file(first, pdf), "2003": () => file(second, pdf), "2004": () => file(PDF, pdf) }, []);
    const { parts, logs } = await runScript(list, fetchFn);

    expect(logs).toContain("Fertig: 3 Belege in 2 ZIP-Datei(en).");
    expect(parts.map((p) => p.name.replace(/\d{4}-\d{2}-\d{2}/, "JJJJ-MM-TT"))).toEqual([
      "fastbill-belege-JJJJ-MM-TT-teil-1.zip",
      "fastbill-belege-JJJJ-MM-TT-teil-2.zip",
    ]);
    const [one, two] = parts.map((p) => unzip(p.bytes));
    expect(one!.files).toEqual(["belege/2002.pdf", "belege/2003.pdf", "manifest.json"]);
    expect(one!.manifest).toMatchObject({ part: 1, count: 2, missing: ["2001"] });
    expect(two!.files).toEqual(["belege/2004.pdf", "manifest.json"]);
    expect(two!.manifest).toMatchObject({ part: 2, count: 1, missing: ["2001"] });

    expect(await receipts.uploadFastbillReceipts(actor, parts[0]!.bytes)).toEqual({ accepted: 2, unknown: 0, invalid: [] });
    expect(await receipts.uploadFastbillReceipts(actor, parts[1]!.bytes)).toEqual({ accepted: 1, unknown: 0, invalid: [] });
    const rows = await sql`select expense_id, status, size from fastbill_receipts order by expense_id`;
    expect(rows.map((r) => [r.expense_id, r.status, r.size])).toEqual([
      ["2001", "wartet", null],
      ["2002", "datei", first.length],
      ["2003", "datei", second.length],
      ["2004", "datei", PDF.length],
    ]);
  });

  it("bricht außerhalb von my.fastbill.com und ohne eingesetzte Liste ab, ohne etwas abzurufen", async () => {
    const list = await waiting({ "3001": `${HOST}/download/3001` });
    const asked: { path: string }[] = [];
    const fetchFn = fakeFastbill({ "3001": () => file(PDF, { "content-type": "application/pdf" }) }, asked);
    await expect(runScript(list, fetchFn, "app.lexware.de")).rejects.toThrow(
      "Bitte in my.fastbill.com ausführen, angemeldet, in der Konsole der Entwicklerwerkzeuge.",
    );
    // Aus der Datei statt über „Skript kopieren“: die Liste ist leer
    await expect(runScript(null, fetchFn)).rejects.toThrow(
      "Die Liste der Belege ist leer. Kopiere das Skript in Haben über „Skript kopieren“, nicht aus der Datei.",
    );
    expect(asked).toEqual([]);
  });
});
