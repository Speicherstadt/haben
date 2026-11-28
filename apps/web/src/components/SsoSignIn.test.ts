import { describe, expect, it } from "vitest";
import { ERNEUT_PAUSE_MS, ssoAutoStart } from "./SsoSignIn.tsx";

/*
 * Aus dem Firmenportal (#504) und nach Ablauf der Frist (#2048) startet die Login-Seite die SSO-Anmeldung selbst, aber nie
 * nach einem abgewiesenen Callback und die erneute Anmeldung höchstens einmal je Minute
 */

describe("ssoAutoStart", () => {
  it("startet mit ?anmelden=sso", () => {
    expect(ssoAutoStart("?anmelden=sso")).toBe(true);
  });

  it.each(["", "?anmelden=passwort", "?anmelden=sso&sso=gruppe", "?sso=fehler&anmelden=sso", "?anmelden=SSO", "?anmelden=erneut&sso=fehler"])(
    "startet nicht bei %j",
    (search) => {
      expect(ssoAutoStart(search)).toBe(false);
    },
  );

  it("startet die erneute Anmeldung nur, wenn ihr letzter Start mindestens eine Minute zurückliegt", () => {
    const jetzt = 1_800_000_000_000;
    expect(ssoAutoStart("?anmelden=erneut&weiter=%2Fbelege", null, jetzt)).toBe(true);
    expect(ssoAutoStart("?anmelden=erneut", jetzt - ERNEUT_PAUSE_MS, jetzt)).toBe(true);
    expect(ssoAutoStart("?anmelden=erneut", jetzt - ERNEUT_PAUSE_MS + 1, jetzt)).toBe(false);
    expect(ssoAutoStart("?anmelden=erneut", jetzt - 5_000, jetzt)).toBe(false);
  });

  it("begrenzt den Wechsel aus dem Firmenportal nicht", () => {
    expect(ssoAutoStart("?anmelden=sso", Date.now(), Date.now())).toBe(true);
  });
});
