import { describe, expect, it } from "vitest";
import { createAppContextCache, navigationZustand } from "./app-navigation.ts";

describe("createAppContextCache", () => {
  const daten = { user: { role: "inhaber" } };

  it("lädt auf dem Server (SSR) immer frisch", () => {
    const cache = createAppContextCache<typeof daten>(() => false);
    cache.seed(daten);
    expect(cache.read("stay")).toBeUndefined();
    expect(cache.read("preload")).toBeUndefined();
  });

  it("lädt beim frischen Betreten von /_app (z. B. nach /login) immer frisch", () => {
    const cache = createAppContextCache<typeof daten>(() => true);
    cache.seed(daten);
    expect(cache.read("enter")).toBeUndefined();
  });

  it("nutzt den gespeicherten Kontext beim Seitenwechsel und Vorladen innerhalb von /_app", () => {
    const cache = createAppContextCache<typeof daten>(() => true);
    cache.seed(daten);
    expect(cache.read("stay")).toBe(daten);
    expect(cache.read("preload")).toBe(daten);
  });

  it("lädt nach clear() (router.invalidate / Abmelden) neu", () => {
    const cache = createAppContextCache<typeof daten>(() => true);
    cache.seed(daten);
    cache.clear();
    expect(cache.read("stay")).toBeUndefined();
  });
});

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
