import { describe, expect, it } from "vitest";
import { ANONYMOUS_BODY_LIMIT, rejectLargeAnonymousBody } from "./body-limit.ts";

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
