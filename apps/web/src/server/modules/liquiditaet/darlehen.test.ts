import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";
import { ACTOR, dkbCsv, firma } from "./test-liquiditaet.ts";

/*
 * Darlehensraten in der Liquiditätsvorschau (#1381) gegen Postgres: die Rate aus Tilgung und Zinsen eines aufgeteilten
 * Umsatzes fortgeschrieben, aufgehobene Zuordnungen zählen nicht, die Tilgung endet am Bestand eines übernommenen Darlehens,
 * ein Darlehen ohne Rate bringt einen Hinweis. Einzelunternehmen SKR03/Ist und GmbH SKR04/Soll.
 */

describe.skipIf(!testDatabaseUrl)("Liquiditätsvorschau: Darlehensraten (Postgres)", () => {
  let sql: postgres.Sql;
  let bank: typeof import("../bank/index.ts");
  let darlehen: typeof import("./darlehen.ts");
  let kontext: typeof import("./kontext.ts");
  let vorschau: typeof import("./vorschau.ts");

  beforeAll(async () => {
    sql = await setupTestDb();
    bank = await import("../bank/index.ts");
    darlehen = await import("./darlehen.ts");
    kontext = await import("./kontext.ts");
    vorschau = await import("./vorschau.ts");
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  const umsatz = async (purpose: string) => (await sql<{ id: string }[]>`select id from bank_transactions where purpose = ${purpose}`)[0]!.id;

  /** Rate als ein Umsatz, aufgeteilt in Tilgung und Zinsen */
  async function rate(loanId: string, purpose: string, tilgung: number, zinsen: number) {
    await bank.allocateSplit(ACTOR, {
      transactionId: await umsatz(purpose),
      parts: [
        { kind: "darlehen", amount: -tilgung, darlehen: { loanId, part: "tilgung" } },
        { kind: "darlehen", amount: -zinsen, darlehen: { loanId, part: "zins" } },
      ],
    });
  }

  const kurz = (posten: Awaited<ReturnType<typeof darlehen.darlehenPosten>>["posten"]) =>
    posten.map((p) => [p.datum, p.betrag, p.sicherheit, p.text, p.quelle.id]);

  it("Einzelunternehmen (SKR03, Ist): Rate aus Tilgung und Zinsen monatlich fortgeschrieben, aufgehobene Zuordnung zählt nicht", async () => {
    await firma(sql, { kontenrahmen: "SKR03", versteuerung: "ist" });
    const loanId = await bank.createLoan(ACTOR, { name: "Hausbank", lender: "bank", term: "ohne", purpose: "betrieb", openingBalance: 0, openingDate: null });
    await bank.importStatement(
      ACTOR,
      dkbCsv([
        ["02.06.26", "Hausbank", "Auszahlung", "20.000,00"],
        ["30.09.26", "Hausbank", "Rate September", "-1.000,00"],
        ["30.10.26", "Hausbank", "Rate Oktober", "-1.000,00"],
      ]),
      null,
    );
    await bank.allocate(ACTOR, { kind: "darlehen", transactionId: await umsatz("Auszahlung"), amount: 20_000_00, darlehen: { loanId, part: "auszahlung" } });
    await rate(loanId, "Rate September", 800_00, 200_00);
    // Erst ganz als Tilgung zugeordnet, aufgehoben, dann richtig aufgeteilt: sonst wären es am 30.10. 1.800 € Tilgung. Die neue
    // Zuordnung wirkt am 31.10., gezahlt ist am 30.10.: Der Rhythmus bleibt beim 30.
    const oktober = await umsatz("Rate Oktober");
    await bank.allocate(ACTOR, { kind: "darlehen", transactionId: oktober, amount: -1000_00, darlehen: { loanId, part: "tilgung" } });
    const [falsch] = await sql<{ id: string }[]>`select id from allocations where transaction_id = ${oktober}`;
    await bank.reverseAllocation(ACTOR, falsch!.id, "2026-10-31");
    await rate(loanId, "Rate Oktober", 800_00, 200_00);

    const { posten, hinweise } = await darlehen.darlehenPosten(await kontext.ladeKontext("2026-11-20", "13w"));
    expect(hinweise).toEqual([]);
    // 30.01.2027 ist ein Samstag
    expect(kurz(posten)).toEqual([
      ["2026-11-30", 1000_00, "erwartet", "Hausbank, Rate wie zuletzt gezahlt", loanId],
      ["2026-12-30", 1000_00, "erwartet", "Hausbank, Rate wie zuletzt gezahlt", loanId],
      ["2027-02-01", 1000_00, "erwartet", "Hausbank, Rate wie zuletzt gezahlt", loanId],
    ]);
    expect(posten[0]).toMatchObject({ richtung: "aus", quelle: { art: "darlehen" } });
  }, 30_000);

  it("Einzelunternehmen (SKR04, Soll): Feiertag in Bayern und nicht gezahlte Rate nach dem ersten Bankumsatz", async () => {
    await firma(sql, { kontenrahmen: "SKR04", versteuerung: "soll" });
    const loanId = await bank.createLoan(ACTOR, {
      name: "Sparkasse",
      lender: "bank",
      term: "bis5",
      purpose: "betrieb",
      openingBalance: 9000_00,
      openingDate: "2026-09-30",
    });
    await bank.importStatement(
      ACTOR,
      dkbCsv([
        ["06.10.26", "Sparkasse", "Rate Oktober", "-450,00"],
        ["06.11.26", "Sparkasse", "Rate November", "-450,00"],
      ]),
      null,
    );
    await rate(loanId, "Rate Oktober", 400_00, 50_00);
    await rate(loanId, "Rate November", 400_00, 50_00);
    const { posten } = await darlehen.darlehenPosten(await kontext.ladeKontext("2026-12-10", "13w"));
    // Die Rate zum 6.12. (Sonntag, also 7.12.) ist nicht gezahlt und bleibt stehen; der 6.1. ist in Bayern Feiertag
    expect(posten.map((p) => p.datum)).toEqual(["2026-12-07", "2027-01-07", "2027-02-08", "2027-03-08"]);
  }, 30_000);

  it("GmbH (SKR04, Soll): übernommenes Darlehen endet mit der Schlussrate, ein Darlehen ohne Rate bringt einen Hinweis", async () => {
    await firma(sql, { rechtsform: "gmbh", kontenrahmen: "SKR04", versteuerung: "soll" });
    const loanId = await bank.createLoan(ACTOR, {
      name: "Förderkredit",
      lender: "bank",
      term: "bis1",
      purpose: "anlagevermoegen",
      openingBalance: 1500_00,
      openingDate: "2026-03-31",
    });
    await bank.createLoan(ACTOR, {
      name: "Leasingbank",
      lender: "sonstige",
      term: "ohne",
      purpose: "betrieb",
      openingBalance: 5000_00,
      openingDate: "2026-10-31",
    });
    await bank.importStatement(
      ACTOR,
      dkbCsv([
        ["30.06.26", "Förderbank", "Rate Q2", "-630,00"],
        ["30.09.26", "Förderbank", "Rate Q3", "-630,00"],
      ]),
      null,
    );
    await rate(loanId, "Rate Q2", 600_00, 30_00);
    await rate(loanId, "Rate Q3", 600_00, 30_00);

    const k = await kontext.ladeKontext("2026-11-20", "6m");
    const { posten, hinweise } = await darlehen.darlehenPosten(k);
    // Bestand 1.500 € − 2 × 600 € = 300 €: die nächste Rate tilgt nur den Rest, danach steht nichts mehr
    expect(kurz(posten)).toEqual([["2026-12-31", 330_00, "erwartet", "Förderkredit, Schlussrate", loanId]]);
    const hinweis = "Für das Darlehen „Leasingbank“ ist noch keine Rate zugeordnet; sie fehlt in der Vorschau.";
    expect(hinweise).toEqual([hinweis]);

    // Auf der Seite: im Dezember mit Link zum Darlehen, der Hinweis im Bericht
    const bericht = await vorschau.liquiditaetsvorschau("2026-11-20", "6m");
    expect(bericht.hinweise).toEqual([hinweis]);
    const dezember = bericht.vorschau.zeitraeume.find((z) => z.von === "2026-12-01")!;
    expect(dezember.posten.filter((p) => p.quelle.art === "darlehen").map((p) => [p.datum, p.betrag])).toEqual([["2026-12-31", 330_00]]);
  }, 30_000);
});
