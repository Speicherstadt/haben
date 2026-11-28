import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, testDatabaseUrl } from "./test-db.ts";
import { cookieOf, ssoTestEnv, startTestProvider, type TestIdentity, type TestProvider } from "./sso-test-provider.ts";

/** Nach Ablauf der Frist (#2048): erneut anmelden und auf dieselbe eigene Seite zurück, nie auf ein fremdes Ziel */
describe.skipIf(!testDatabaseUrl)("SSO: Rückkehr nach erneuter Anmeldung (Postgres)", () => {
  let database: postgres.Sql;
  let provider: TestProvider;
  let handleAuth: typeof import("./auth.ts").handleAuth;
  let sessionUser: typeof import("./rollen.ts").sessionUser;
  let ssoSitzungAbgelaufen: typeof import("./sso-policy.ts").ssoSitzungAbgelaufen;
  let client = 1;

  const request = (path: string, body?: unknown, cookie = "") =>
    handleAuth(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          origin: "http://localhost:3000",
          "x-forwarded-for": `127.11.${Math.floor(client / 250)}.${client++ % 250}`,
          ...(body ? { "content-type": "application/json" } : {}),
          cookie,
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  async function login(callbackURL: unknown, identity: TestIdentity) {
    const start = await request("/sign-in/social", { provider: "oidc", callbackURL });
    expect(start.status).toBe(200);
    const url = new URL((await start.json()).url);
    const code = provider.issue(url, identity);
    return request(`/callback/oidc?code=${code}&state=${url.searchParams.get("state")}`, undefined, cookieOf(start.headers));
  }
  /** Ziel des Redirects nach dem Callback als Pfad mit Suchzeile; ein fremder Host bliebe sichtbar */
  const ziel = (response: Response) => {
    expect(response.status).toBe(302);
    const url = new URL(response.headers.get("location") ?? "", "http://localhost:3000");
    return url.origin === "http://localhost:3000" ? url.pathname + url.search : url.href;
  };
  const inhaber = (sub: string): TestIdentity => ({ sub, email: `${sub}@example.de`, groups: ["haben-inhaber"] });

  beforeAll(async () => {
    provider = await startTestProvider();
    Object.assign(process.env, ssoTestEnv(provider.issuer), { HABEN_SETUP_CODE: "test-setup-code" });
    database = await setupTestDb();
    ({ handleAuth } = await import("./auth.ts"));
    ({ sessionUser } = await import("./rollen.ts"));
    ({ ssoSitzungAbgelaufen } = await import("./sso-policy.ts"));
    // Zwei RSA-Schlüssel und eine Datenbank aus der Vorlage brauchen unter Volllast länger als die Vorgabe
  }, 60_000);
  afterAll(async () => {
    await provider?.close();
    await database?.end();
    const { closeDatabase } = await import("./db/index.ts");
    await closeDatabase();
  });

  it("kehrt nach dem Callback auf die geprüfte eigene Seite zurück", async () => {
    expect(ziel(await login("/", inhaber("start")))).toBe("/");
    expect(ziel(await login("/einstellungen?bereich=zugaenge", inhaber("start")))).toBe("/einstellungen?bereich=zugaenge");
  });

  it.each(["https://evil.example/", "//evil.example/belege", "/\\evil.example", "/login?anmelden=erneut", "/api/auth/sign-out", 42])(
    "führt bei %j zur Startseite",
    async (callbackURL) => {
      expect(ziel(await login(callbackURL, inhaber("start")))).toBe("/");
    },
  );

  it("erkennt eine abgelaufene Sitzung am verbliebenen Cookie, nicht ohne Cookie und nicht bei gültiger Sitzung", async () => {
    const cookie = cookieOf((await login("/", inhaber("frist"))).headers);
    const headers = new Headers({ cookie });
    expect(await sessionUser(headers)).toBeTruthy();
    expect(ssoSitzungAbgelaufen(headers, true)).toBe(false);

    await database`update session set sso_expires_at = now() - interval '1 second'
      where user_id = (select id from "user" where email = 'frist@example.de')`;
    expect(await sessionUser(headers)).toBeNull();
    expect(ssoSitzungAbgelaufen(headers, false)).toBe(true);
    expect(ssoSitzungAbgelaufen(new Headers(), false)).toBe(false);
  });
});
