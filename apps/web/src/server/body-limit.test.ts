import { describe, expect, it } from "vitest";
import { ANONYMOUS_BODY_LIMIT, AUTH_BODY_LIMIT, limitAuthBody, readBodyLimited, rejectLargeAnonymousBody } from "./body-limit.ts";

describe("Große Anfragen ohne Anmeldung", () => {
  const serverFn = "/_serverFn/abc";
  const call = (method: string, headers: Record<string, string>, loggedIn: boolean, pathname = serverFn) => {
    let checked = 0;
    const request = new Request(`http://app:3000${pathname}`, { method, headers });
    return rejectLargeAnonymousBody(request, pathname, async () => {
      checked += 1;
      return loggedIn;
    }).then((response) => ({ status: response?.status ?? null, checked }));
  };
  const big = String(ANONYMOUS_BODY_LIMIT + 1);

  it("lehnt eine große Anfrage ohne gültige Sitzung mit 413 ab", async () => {
    expect(await call("POST", { "content-length": big }, false)).toEqual({ status: 413, checked: 1 });
    expect(await call("POST", { "content-length": "250000000" }, false)).toEqual({ status: 413, checked: 1 });
  });

  it("ein mitgeschicktes Cookie mit dem Namen der Sitzung genügt nicht; geprüft wird die Sitzung", async () => {
    const headers = { "content-length": big, cookie: "better-auth.session_token=erfunden" };
    expect(await call("POST", headers, false)).toEqual({ status: 413, checked: 1 });
  });

  it("lässt eine große Anfrage mit gültiger Sitzung durch, damit Uploads weiter gehen", async () => {
    expect(await call("POST", { "content-length": "250000000" }, true)).toEqual({ status: null, checked: 1 });
  });

  it("prüft kleine Anfragen gar nicht, auch ohne Anmeldung (Anmeldung, Einrichtung)", async () => {
    expect(await call("POST", { "content-length": String(ANONYMOUS_BODY_LIMIT) }, false)).toEqual({ status: null, checked: 0 });
    expect(await call("POST", { "content-length": "0" }, false)).toEqual({ status: null, checked: 0 });
  });

  it("behandelt eine Anfrage ohne Größenangabe (etwa chunked) als groß", async () => {
    expect(await call("POST", { "transfer-encoding": "chunked" }, false)).toEqual({ status: 413, checked: 1 });
    expect(await call("POST", {}, false)).toEqual({ status: 413, checked: 1 });
    expect(await call("POST", { "content-length": "abc" }, false)).toEqual({ status: 413, checked: 1 });
    expect(await call("POST", { "transfer-encoding": "chunked" }, true)).toEqual({ status: null, checked: 1 });
  });

  it("betrifft nur schreibende Anfragen an Server Functions", async () => {
    expect(await call("GET", { "content-length": big }, false)).toEqual({ status: null, checked: 0 });
    expect(await call("POST", { "content-length": big }, false, "/api/auth/sign-in/email")).toEqual({ status: null, checked: 0 });
    expect(await call("POST", { "content-length": big }, false, "/api/mcp")).toEqual({ status: null, checked: 0 });
  });
});

describe("readBodyLimited", () => {
  const stream = (chunks: number[]) =>
    new Request("http://app:3000/api", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const size of chunks) controller.enqueue(new Uint8Array(size).fill(1));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);

  it("liest einen Body ohne Content-Length bis zur Grenze vollständig", async () => {
    expect((await readBodyLimited(stream([40, 60]), 100))?.byteLength).toBe(100);
  });

  it("bricht ab, sobald der Body größer wird, und liefert null", async () => {
    expect(await readBodyLimited(stream([60, 60, 60]), 100)).toBeNull();
  });

  it("liefert ohne Body ein leeres Array", async () => {
    expect((await readBodyLimited(new Request("http://app:3000/api", { method: "POST" }), 100))?.byteLength).toBe(0);
  });
});

describe("limitAuthBody (/api/auth)", () => {
  const chunked = (bytes: number) =>
    new Request("http://app:3000/api/auth/sign-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (let sent = 0; sent < bytes; sent += 16 * 1024) controller.enqueue(new Uint8Array(16 * 1024).fill(0x20));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);

  it("lehnt große Bodys ab, mit und ohne Content-Length", async () => {
    expect(await limitAuthBody(chunked(AUTH_BODY_LIMIT + 16 * 1024))).toBeNull();
    const declared = new Request("http://app:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Length": String(AUTH_BODY_LIMIT + 1) },
      body: "{}",
    });
    expect(await limitAuthBody(declared)).toBeNull();
  });

  it("gibt kleine Bodys unverändert weiter, samt Methode, Headern und Adresse", async () => {
    const body = JSON.stringify({ email: "inhaber@example.de", password: "geheim" });
    const request = await limitAuthBody(
      new Request("http://app:3000/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json", Cookie: "a=b" }, body }),
    );
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("http://app:3000/api/auth/sign-in/email");
    expect(request?.headers.get("cookie")).toBe("a=b");
    expect(await request?.json()).toEqual(JSON.parse(body));
  });

  it("lässt GET ohne Body unverändert", async () => {
    const get = new Request("http://app:3000/api/auth/get-session");
    expect(await limitAuthBody(get)).toBe(get);
  });
});
