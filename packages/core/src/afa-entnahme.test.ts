import { describe, expect, it } from "vitest";
import { entnahmePosting, entnahmeUmsatz, restbuchwertKonto } from "./afa-entnahme.ts";
import { euerErgebnis } from "./euer.ts";
import { euerAusZeilen, euerZuordnung, istEuerEinnahme } from "./journal-euer.ts";

/*
 * Entnahme einer Anlage (#1970): Umsatzsteuer nach § 3 Abs. 1b UStG, Buchung auf „Erlöse aus Verkäufen
 * Sachanlagevermögen“ (DATEV-Kontenrahmen 2026) und Zeile 19 der Anlage EÜR. SKR03 und SKR04, regelbesteuert und
 * Kleinunternehmer, mit und ohne Vorsteuer beim Kauf.
 */

const balanced = (lines: { debit: number; credit: number }[]) => lines.reduce((s, l) => s + l.debit, 0) === lines.reduce((s, l) => s + l.credit, 0);

describe("Umsatzsteuer auf die Entnahme einer Anlage", () => {
  it("regelbesteuert mit Vorsteuer beim Kauf: 19 % auf den Entnahmewert (§ 3 Abs. 1b Nr. 1, § 10 Abs. 4 Nr. 1 UStG)", () => {
    expect(entnahmeUmsatz({ value: 120_000, inputVat: true }, false)).toEqual({ steuer: "steuerpflichtig", base: 120_000, vat: 22_800 });
  });

  it("Kleinunternehmer mit Vorsteuer beim Kauf: steuerfrei nach § 19 Abs. 1 UStG, Bemessungsgrundlage für Kz 48", () => {
    expect(entnahmeUmsatz({ value: 120_000, inputVat: true }, true)).toEqual({ steuer: "kleinunternehmer", base: 120_000, vat: 0 });
  });

  it("ohne Vorsteuer beim Kauf: nicht steuerbar (§ 3 Abs. 1b Satz 2 UStG), auch als Kleinunternehmer", () => {
    expect(entnahmeUmsatz({ value: 120_000, inputVat: false }, false)).toEqual({ steuer: "nichtSteuerbar", base: 0, vat: 0 });
    expect(entnahmeUmsatz({ value: 120_000, inputVat: false }, true)).toEqual({ steuer: "nichtSteuerbar", base: 0, vat: 0 });
  });
});

describe("Buchung der Entnahme", () => {
  it("SKR03, mit Umsatzsteuer, Buchgewinn: 1800 an 8820 und 1776", () => {
    const lines = entnahmePosting(entnahmeUmsatz({ value: 120_000, inputVat: true }, false), 120_000, 100_000, "SKR03");
    expect(lines).toEqual([
      { account: "1800", debit: 142_800, credit: 0, taxCode: null },
      { account: "8820", debit: 0, credit: 120_000, taxCode: "USt19" },
      { account: "1776", debit: 0, credit: 22_800, taxCode: "USt19" },
    ]);
    expect(balanced(lines)).toBe(true);
  });

  it("SKR03, mit Umsatzsteuer, Buchverlust: 8801", () => {
    const lines = entnahmePosting(entnahmeUmsatz({ value: 50_000, inputVat: true }, false), 50_000, 100_000, "SKR03");
    expect(lines.map((l) => l.account)).toEqual(["1800", "8801", "1776"]);
  });

  it("SKR04, ohne Umsatzsteuer: 2100 an 4849 (Buchgewinn) bzw. 6889 (Buchverlust)", () => {
    const gewinn = entnahmePosting(entnahmeUmsatz({ value: 80_000, inputVat: true }, true), 80_000, 80_000, "SKR04");
    expect(gewinn).toEqual([
      { account: "2100", debit: 80_000, credit: 0, taxCode: null },
      { account: "4849", debit: 0, credit: 80_000, taxCode: null },
    ]);
    const verlust = entnahmePosting(entnahmeUmsatz({ value: 30_000, inputVat: false }, false), 30_000, 80_000, "SKR04");
    expect(verlust.map((l) => l.account)).toEqual(["2100", "6889"]);
  });

  it("SKR04, mit Umsatzsteuer: 4845 bzw. 6885 und 3806", () => {
    expect(entnahmePosting(entnahmeUmsatz({ value: 80_000, inputVat: true }, false), 80_000, 0, "SKR04").map((l) => l.account)).toEqual([
      "2100",
      "4845",
      "3806",
    ]);
    expect(entnahmePosting(entnahmeUmsatz({ value: 80_000, inputVat: true }, false), 80_000, 90_000, "SKR04").map((l) => l.account)).toEqual([
      "2100",
      "6885",
      "3806",
    ]);
  });

  it("Entnahmewert 0: keine Buchung", () => {
    expect(entnahmePosting(entnahmeUmsatz({ value: 0, inputVat: true }, false), 0, 0, "SKR03")).toEqual([]);
  });

  it("Restbuchwert: bei Buchgewinn 2315 bzw. 4855, sonst und ohne Entnahme 2310 bzw. 6895", () => {
    expect(restbuchwertKonto("SKR03", { value: 100_000, inputVat: true }, 100_000)).toBe("2315");
    expect(restbuchwertKonto("SKR03", { value: 99_999, inputVat: true }, 100_000)).toBe("2310");
    expect(restbuchwertKonto("SKR03", null, 100_000)).toBe("2310");
    expect(restbuchwertKonto("SKR04", { value: 100_000, inputVat: false }, 50_000)).toBe("4855");
    expect(restbuchwertKonto("SKR04", { value: 10_000, inputVat: false }, 50_000)).toBe("6895");
    expect(restbuchwertKonto("SKR04", null, 50_000)).toBe("6895");
  });
});

describe("Entnahme in der EÜR (Anleitung EÜR 2025, Zeilen 17 und 19)", () => {
  it.each([
    ["SKR03", ["8820", "8801", "8829", "8800"], "2315", "1776"],
    ["SKR04", ["4845", "6885", "4849", "6889"], "4855", "3806"],
  ] as const)("%s: Erlöskonten der Entnahme in Zeile 19, Restbuchwert bei Buchgewinn wie bei Buchverlust", (kr, erloese, restbuchwert, ust) => {
    for (const konto of erloese) expect(euerZuordnung(kr, konto, "asset"), konto).toBe("anlagenabgang");
    expect(euerZuordnung(kr, restbuchwert, "asset")).toBe("restbuchwert");
    expect(euerZuordnung(kr, ust, "asset")).toBe("ustEntnahmen");
    expect(istEuerEinnahme("anlagenabgang")).toBe(true);
  });

  it("Kleinunternehmer: der Entnahmewert bleibt in Zeile 19", () => {
    expect(euerZuordnung("SKR03", "8829", "asset", true)).toBe("anlagenabgang");
  });

  it("die Buchung als Ganzes: Entnahmewert in Zeile 19, Umsatzsteuer als Umsatzsteuer auf unentgeltliche Wertabgaben", () => {
    const lines = entnahmePosting(entnahmeUmsatz({ value: 120_000, inputVat: true }, false), 120_000, 100_000, "SKR04");
    expect(euerAusZeilen("SKR04", lines, "asset").zeilen).toEqual({ anlagenabgang: 120_000, ustEntnahmen: 22_800 });
  });
});

describe("Zeile 19 in der EÜR aus dem Anlagenverzeichnis", () => {
  it("vor dem Buchen: Entnahmewert in Zeile 19 hinter den steuerfreien Einnahmen, Umsatzsteuer darauf als Wertabgabe", () => {
    const leer = { einnahmen: Array(12).fill(0), ausgaben: Array(12).fill(0) };
    const euer = euerErgebnis(2026, new Map(), leer, 0, 0, undefined, { privateKfz: 0, ustEntnahmen: 22_800, anlagenabgang: 120_000 });
    expect(euer.einnahmen.map((l) => l.key)).toEqual([
      "einnahmenSteuerpflichtig",
      "einnahmenSteuerfrei",
      "anlagenabgang",
      "vereinnahmteUst",
      "ustEntnahmen",
      "erstatteteUst",
    ]);
    expect(euer.einnahmen.find((l) => l.key === "anlagenabgang")?.label).toBe("Veräußerung oder Entnahme von Anlagevermögen");
    expect(euer.gewinn).toBe(142_800);
  });
});
