import { describe, expect, it } from "vitest";
import { navigationZustand } from "./app-navigation.ts";

describe("navigationZustand", () => {
  it("meldet wechseltSeite beim Wechsel auf eine andere Route", () => {
    expect(navigationZustand({ status: "pending", locationPathname: "/rechnungen", resolvedPathname: "/bank", matchPathname: "/bank" })).toEqual({
      resolvedPathname: "/bank",
      navPathname: "/rechnungen",
      wechseltSeite: true,
    });
  });

  it("lässt dieselbe Seite stehen, wenn sich nur Suchparameter ändern", () => {
    expect(navigationZustand({ status: "pending", locationPathname: "/bank", resolvedPathname: "/bank", matchPathname: "/bank" })).toEqual({
      resolvedPathname: "/bank",
      navPathname: "/bank",
      wechseltSeite: false,
    });
  });

  it("zeigt nach Abschluss des Ladens keinen Wechsel mehr", () => {
    expect(navigationZustand({ status: "idle", locationPathname: "/rechnungen", resolvedPathname: "/rechnungen", matchPathname: "/rechnungen" })).toEqual({
      resolvedPathname: "/rechnungen",
      navPathname: "/rechnungen",
      wechseltSeite: false,
    });
  });

  it("fällt ohne resolvedPathname auf locationPathname zurück", () => {
    expect(navigationZustand({ status: "pending", locationPathname: "/bank", resolvedPathname: undefined, matchPathname: "/bank" })).toEqual({
      resolvedPathname: "/bank",
      navPathname: "/bank",
      wechseltSeite: false,
    });
  });

  it("zeigt die neue Seite, sobald ihre Matches übergeben sind, auch wenn der Router noch pending meldet", () => {
    // Zwischen Übergabe und idle stellt der Router die Rollposition her; dafür muss die Seite schon stehen
    expect(navigationZustand({ status: "pending", locationPathname: "/rechnungen", resolvedPathname: "/bank", matchPathname: "/rechnungen" })).toEqual({
      resolvedPathname: "/bank",
      navPathname: "/rechnungen",
      wechseltSeite: false,
    });
  });
});
