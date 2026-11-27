import { describe, expect, it } from "vitest";
import { navigationZustand } from "./app-navigation.ts";

describe("navigationZustand", () => {
  it("meldet wechseltSeite beim Wechsel auf eine andere Route", () => {
    expect(navigationZustand({ status: "pending", locationPathname: "/rechnungen", resolvedPathname: "/bank" })).toEqual({
      resolvedPathname: "/bank",
      navPathname: "/rechnungen",
      wechseltSeite: true,
    });
  });

  it("lässt dieselbe Seite stehen, wenn sich nur Suchparameter ändern", () => {
    expect(navigationZustand({ status: "pending", locationPathname: "/bank", resolvedPathname: "/bank" })).toEqual({
      resolvedPathname: "/bank",
      navPathname: "/bank",
      wechseltSeite: false,
    });
  });

  it("zeigt nach Abschluss des Ladens keinen Wechsel mehr", () => {
    expect(navigationZustand({ status: "idle", locationPathname: "/rechnungen", resolvedPathname: "/rechnungen" })).toEqual({
      resolvedPathname: "/rechnungen",
      navPathname: "/rechnungen",
      wechseltSeite: false,
    });
  });

  it("fällt ohne resolvedPathname auf locationPathname zurück", () => {
    expect(navigationZustand({ status: "pending", locationPathname: "/bank", resolvedPathname: undefined })).toEqual({
      resolvedPathname: "/bank",
      navPathname: "/bank",
      wechseltSeite: false,
    });
  });
});
