import nodemailer from "nodemailer";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "../../test-db.ts";

type Sent = { from: { name: string; address: string }; replyTo?: string };

describe.skipIf(!testDatabaseUrl)("Absender der E-Mails (Postgres)", () => {
  let mail: typeof import("./mail.ts");
  let dbModule: typeof import("../../db/index.ts");
  let actorModule: typeof import("../../db/actor.ts");
  let sql: postgres.Sql;
  const actor = "test-user";
  const sent: Sent[] = [];
  /** Die fertige Nachricht, wie nodemailer sie per SMTP übergäbe (Kopf und Inhalt) */
  const raw: string[] = [];

  const settings = {
    host: "smtp.example.com",
    port: 465,
    secure: true,
    username: "max",
    password: "geheim",
    fromAddress: "rechnung@testfirma.example",
    reminderTo: "max@testfirma.example",
    remindersEnabled: false,
    reminderDays: [],
  };

  beforeAll(async () => {
    sql = await setupTestDb();
    mail = await import("./mail.ts");
    dbModule = await import("../../db/index.ts");
    actorModule = await import("../../db/actor.ts");
    mail.setMailTransportForTests(() => {
      const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
      return {
        sendMail: async (message: Sent) => {
          sent.push(message);
          const info = await transport.sendMail(message);
          raw.push((info.message as Buffer).toString("utf8"));
          return info;
        },
      };
    });
  }, 30_000);

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(() => {
    sent.length = 0;
    raw.length = 0;
  });

  /** Die Kopfzeilen der fertigen Nachricht, bis zur ersten Leerzeile */
  const header = () => raw[0]!.split("\n\n")[0]!;

  async function setCompanyName(name: string) {
    const { schema } = dbModule;
    await actorModule.withActor(actor, (tx) =>
      tx.insert(schema.company).values({ id: 1, name }).onConflictDoUpdate({ target: schema.company.id, set: { name } }),
    );
  }

  it("nimmt den eingetragenen Absendernamen", async () => {
    await mail.saveMailSettings(actor, { ...settings, fromName: "Muster IT-Beratung" });
    await mail.sendTestMail(actor);
    expect(sent[0]!.from).toEqual({ name: "Muster IT-Beratung", address: "rechnung@testfirma.example" });
    expect((await mail.mailSettingsSummary())!.fromName).toBe("Muster IT-Beratung");
  });

  it("nimmt ohne Absendernamen den Firmennamen", async () => {
    await setCompanyName("Testfirma GmbH");
    await mail.saveMailSettings(actor, { ...settings, fromName: "  " });
    await mail.sendTestMail(actor);
    expect(sent[0]!.from.name).toBe("Testfirma GmbH");
  });

  it("nimmt „Haben“, wenn weder Absendername noch Firmenname eingetragen sind", async () => {
    await setCompanyName("");
    await mail.saveMailSettings(actor, settings);
    await mail.sendTestMail(actor);
    expect(sent[0]!.from.name).toBe("Haben");
  });

  // RFC 5322, 3.6.2: Das Feld „Reply-To:“ nennt die Adresse, an die Antworten gehen sollen; nach 3.6.3 richtet sich eine
  // Antwort dann an diese Adresse statt an „From:“
  it("setzt die Antwortadresse als Kopfzeile Reply-To, der Absender bleibt", async () => {
    await mail.saveMailSettings(actor, { ...settings, fromName: "Muster IT-Beratung", replyTo: "antworten@testfirma.example" });
    await mail.sendTestMail(actor);
    expect(header()).toMatch(/^Reply-To: antworten@testfirma\.example$/m);
    expect(header()).toMatch(/^From: "?Muster IT-Beratung"? <rechnung@testfirma\.example>$/m);
  });

  it("setzt ohne Antwortadresse keine Kopfzeile Reply-To", async () => {
    await mail.saveMailSettings(actor, { ...settings, fromName: "Muster IT-Beratung" });
    expect(await mail.sendTestMail(actor)).toEqual({ ok: true, error: null });
    expect(sent[0]).not.toHaveProperty("replyTo");
    expect(header()).not.toMatch(/^Reply-To:/im);
    expect(header()).toMatch(/^From: "?Muster IT-Beratung"? <rechnung@testfirma\.example>$/m);
  });
});
