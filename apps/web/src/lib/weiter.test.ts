import { describe, expect, it } from "vitest";
import { eigenesZiel, weiterNachAnmeldung } from "./weiter.ts";

describe("weiterNachAnmeldung", () => {
  it("kehrt zur Zustimmungsseite und zu eigenen Seiten zurück", () => {
    for (const ziel of ["/oauth/autorisieren?client_id=abc&state=1e5", "/einstellungen?bereich=zugaenge", "/", "/belege/42"])
      expect(weiterNachAnmeldung(`?weiter=${encodeURIComponent(ziel)}`)).toBe(ziel);
    expect(weiterNachAnmeldung("")).toBeNull();
  });

  it("lehnt fremde Ziele ab", () => {
    for (const ziel of ["https://evil.example/", "//evil.example", "/\\evil.example", "\\\\evil.example", "/\tevil", "javascript:alert(1)", "einstellungen"])
      expect(weiterNachAnmeldung(`?weiter=${encodeURIComponent(ziel)}`)).toBeNull();
  });

  it("kehrt nie zu Schnittstellen oder zur Anmeldung selbst zurück, auch nicht über Umwege im Pfad", () => {
    for (const ziel of ["/api/auth/sign-out", "/login", "/login?anmelden=sso", "/setup", "/einladung/abc", "/belege/../login", "/./api/mcp"])
      expect(weiterNachAnmeldung(`?weiter=${encodeURIComponent(ziel)}`)).toBeNull();
  });
});

describe("eigenesZiel", () => {
  it("nimmt nur Zeichenketten und gibt den normalisierten Pfad ohne Fragment zurück", () => {
    expect(eigenesZiel(undefined)).toBeNull();
    expect(eigenesZiel(["/"])).toBeNull();
    expect(eigenesZiel("/belege/./42?seite=2#oben")).toBe("/belege/42?seite=2");
    expect(eigenesZiel("/loginseite")).toBe("/loginseite");
  });
});
