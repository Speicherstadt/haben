import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leeren, setupTestDb, testDatabaseUrl } from "../../test-db.ts";

/*
 * Offene Einspruchsfristen je Steuerfall und Zeitraum: Ein Änderungsbescheid ersetzt den Bescheid, den er ändert, und
 * damit dessen Frist. Die Fälle hier kommen ohne ELSTER aus, sie schreiben die Dokumente direkt in die Datenbank
 * (#1817).
 */
describe.skipIf(!testDatabaseUrl)("Offene Einspruchsfristen (Postgres)", () => {
  let postfach: typeof import("./postfach.ts");
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = await setupTestDb();
    postfach = await import("./postfach.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    await leeren(sql)`truncate company, postfach_documents, postfach_requests cascade`;
    await sql`insert into company (id, name, strasse, plz, ort, steuernummer, bundesland)
              values (1, 'Testfirma', 'Musterstraße 1', '24103', 'Kiel', '000/000/00000', 'SH')`;
  });

  interface Dokument {
    nummer: number;
    datenart?: string;
    veranlagungszeitraum?: string;
    steuernummer?: string;
    bescheiddatum: string;
    bereitstellungId?: string;
    bezeichnung?: string;
    test?: boolean;
  }

  async function bescheid(d: Dokument) {
    const [request] = await sql`
      insert into postfach_requests (art, test, ok, code, message, bereitstellung_ids, fehler,
        request_xml, response_xml, server_response_xml)
      values ('anfrage', false, true, 0, 'Verarbeitung fehlerfrei.', '{}'::text[], '[]'::jsonb, '', '', '')
      returning id`;
    await sql`
      insert into postfach_documents (referenz_id, bereitstellung_id, datenart, veranlagungszeitraum,
        steuernummer, bescheiddatum, dateibezeichnung, mime_type, filename, sha256, size, test, request_id)
      values (${`ref-${d.nummer}`}, ${d.bereitstellungId ?? `bereitstellung-${d.nummer}`},
        ${d.datenart ?? "DivaBescheidESt"}, ${d.veranlagungszeitraum ?? "2025"},
        ${d.steuernummer ?? "000/000/00000"}, ${d.bescheiddatum}, ${d.bezeichnung ?? "Einkommensteuerbescheid"},
        'application/pdf', ${`Bescheid_${d.nummer}.pdf`}, ${`hash-${d.nummer}`}, 1000, ${d.test ?? false}, ${request!.id})`;
  }

  it("lässt den ersetzten Bescheid fallen und behält die Frist des Änderungsbescheids", async () => {
    await bescheid({ nummer: 1, bescheiddatum: "20261109" });
    await bescheid({ nummer: 2, bescheiddatum: "20261119" });

    const offen = await postfach.openAppealDeadlines("2026-11-23");

    expect(offen).toHaveLength(1);
    expect(offen[0]!.bescheiddatum).toBe("20261119");
    expect(offen[0]!.frist?.fristende).toBe("2026-12-23");
  });

  it("zählt Anhänge desselben Bescheids als eine Frist, auch bei verschiedenen Bezeichnungen", async () => {
    await bescheid({ nummer: 1, bescheiddatum: "20261119", bereitstellungId: "b-1", bezeichnung: "Einkommensteuerbescheid 2025" });
    await bescheid({ nummer: 2, bescheiddatum: "20261119", bereitstellungId: "b-1", bezeichnung: "Erläuterungen" });

    expect(await postfach.openAppealDeadlines("2026-11-23")).toHaveLength(1);
  });

  it("hält zwei Steuernummern auseinander", async () => {
    await bescheid({ nummer: 1, bescheiddatum: "20261109", steuernummer: "000/000/00001" });
    await bescheid({ nummer: 2, bescheiddatum: "20261119", steuernummer: "000/000/00002" });

    const offen = await postfach.openAppealDeadlines("2026-11-23");

    expect(offen.map((d) => d.frist?.fristende)).toEqual(["2026-12-14", "2026-12-23"]);
  });

  it("hält Datenart und Veranlagungszeitraum auseinander", async () => {
    await bescheid({ nummer: 1, datenart: "DivaBescheidUSt", bescheiddatum: "20261109" });
    await bescheid({ nummer: 2, datenart: "DivaBescheidESt", bescheiddatum: "20261119" });
    await bescheid({ nummer: 3, datenart: "DivaBescheidESt", veranlagungszeitraum: "2024", bescheiddatum: "20261119" });

    expect(await postfach.openAppealDeadlines("2026-11-23")).toHaveLength(3);
  });

  it("ersetzt den Bescheid desselben Zeitraums, auch bei anderer Schreibweise", async () => {
    await bescheid({
      nummer: 1,
      datenart: "DivaBescheidUSt",
      bescheiddatum: "20261109",
      bezeichnung: "Umsatzsteuer-Vorauszahlungsbescheid Januar 2025",
    });
    await bescheid({
      nummer: 2,
      datenart: "DivaBescheidUSt",
      bescheiddatum: "20261119",
      bezeichnung: "Umsatzsteuer-Vorauszahlungsbescheid Januar 2025".toUpperCase(),
    });

    const offen = await postfach.openAppealDeadlines("2026-11-23");

    expect(offen).toHaveLength(1);
    expect(offen[0]!.frist?.fristende).toBe("2026-12-23");
  });

  it("hält zwei Zeiträume desselben Steuerfalls auseinander", async () => {
    // Zwei eigenständige Bescheide für 2025, gleiche Steuernummer: der Februar-Bescheid ersetzt den Januar nicht
    await bescheid({
      nummer: 1,
      datenart: "DivaBescheidUSt",
      bescheiddatum: "20261109",
      bezeichnung: "Umsatzsteuer-Vorauszahlungsbescheid Januar 2025",
    });
    await bescheid({
      nummer: 2,
      datenart: "DivaBescheidUSt",
      bescheiddatum: "20261119",
      bezeichnung: "Umsatzsteuer-Vorauszahlungsbescheid Februar 2025",
    });

    const offen = await postfach.openAppealDeadlines("2026-11-23");

    expect(offen.map((d) => d.frist?.fristende)).toEqual(["2026-12-14", "2026-12-23"]);
  });

  it("hält sonstige Bescheide eines Jahres mit abweichender Bezeichnung getrennt", async () => {
    // DivaSonstigerVA sammelt beliebige Bescheide eines Jahres; gleicher Schlüssel heißt dort nicht Ersatz
    await bescheid({
      nummer: 1,
      datenart: "DivaSonstigerVA",
      bescheiddatum: "20261109",
      bezeichnung: "Nachforderung Umsatzsteuer Januar 2025",
    });
    await bescheid({
      nummer: 2,
      datenart: "DivaSonstigerVA",
      bescheiddatum: "20261119",
      bezeichnung: "Ablehnung Stundungsantrag Februar 2025",
    });

    expect(await postfach.openAppealDeadlines("2026-11-23")).toHaveLength(2);
  });

  it("legt Bescheide ohne Veranlagungszeitraum nicht zusammen", async () => {
    // Ohne Zeitraum ist nicht bestimmt, ob der zweite den ersten ersetzt; lieber zwei Aufgaben als eine Frist zu wenig
    await bescheid({ nummer: 1, veranlagungszeitraum: "", bescheiddatum: "20261109" });
    await bescheid({ nummer: 2, veranlagungszeitraum: "", bescheiddatum: "20261119" });

    expect(await postfach.openAppealDeadlines("2026-11-23")).toHaveLength(2);
  });

  it("hält gleich benannte sonstige Verwaltungsakte getrennt", async () => {
    // Zwei Verspätungszuschläge desselben Jahres heißen gleich und sind trotzdem zwei Fristen
    await bescheid({ nummer: 1, datenart: "DivaSonstigerVA", bescheiddatum: "20261109", bezeichnung: "Verspätungszuschlag" });
    await bescheid({ nummer: 2, datenart: "DivaSonstigerVA", bescheiddatum: "20261119", bezeichnung: "Verspätungszuschlag" });

    expect(await postfach.openAppealDeadlines("2026-11-23")).toHaveLength(2);
  });

  it.each([
    { fall: "sonstiger Verwaltungsakt", datenart: "DivaSonstigerVA", veranlagungszeitraum: "2025" },
    { fall: "ohne Veranlagungszeitraum", datenart: "DivaBescheidESt", veranlagungszeitraum: "" },
  ])("zählt Anhänge desselben Bescheids auch ohne Zusammenlegen als eine Frist ($fall)", async (d) => {
    // Was nicht zusammengelegt wird, bleibt je Bereitstellung eine Aufgabe, nicht je Datei
    await bescheid({ ...d, nummer: 1, bescheiddatum: "20261119", bereitstellungId: "b-1", bezeichnung: "Verspätungszuschlag" });
    await bescheid({ ...d, nummer: 2, bescheiddatum: "20261119", bereitstellungId: "b-1", bezeichnung: "Erläuterungen" });

    expect(await postfach.openAppealDeadlines("2026-11-23")).toHaveLength(1);
  });

  it("vergleicht Bescheiddaten in gemischter Schreibweise als Datum", async () => {
    await bescheid({ nummer: 1, bescheiddatum: "20261109" });
    await bescheid({ nummer: 2, bescheiddatum: "19.11.2026" });

    const offen = await postfach.openAppealDeadlines("2026-11-23");

    expect(offen).toHaveLength(1);
    expect(offen[0]!.frist?.fristende).toBe("2026-12-23");
  });

  it("übergeht Testbescheide und abgelaufene Fristen", async () => {
    await bescheid({ nummer: 1, bescheiddatum: "20260105" });
    await bescheid({ nummer: 2, bescheiddatum: "20261119", test: true });

    expect(await postfach.openAppealDeadlines("2026-11-23")).toHaveLength(0);
  });
});
