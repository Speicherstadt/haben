import { describe, expect, it } from "vitest";
import {
  dauerbelegFaellig,
  dauerbelegPeriode,
  dauerbelegProbleme,
  dauerbelegSummen,
  faelligeTermine,
  folgeTermin,
  KLEINBETRAG_AUFTEILUNG,
  KLEINBETRAG_HINWEIS,
  terminAbStichtag,
  VORSTEUER_HINWEIS,
  vorschauTermine,
} from "./dauerbeleg.ts";

const monatlich = (nextDate: string, anchorDay = Number(nextDate.slice(8, 10)), endDate: string | null = null) => ({
  nextDate,
  recurrence: "P1M" as const,
  anchorDay,
  endDate,
});

describe("Dauerbelege: Termine", () => {
  it("Monatsende: der 31. wird im Februar zum 28. und springt danach zurück", () => {
    expect(vorschauTermine(monatlich("2026-01-31"), 4)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("Schaltjahr: 29. Februar 2028, im Folgejahr der 28., 2032 wieder der 29.", () => {
    expect(vorschauTermine(monatlich("2028-01-31"), 3)).toEqual(["2028-01-31", "2028-02-29", "2028-03-31"]);
    const jaehrlich = { nextDate: "2028-02-29", recurrence: "P1Y" as const, anchorDay: 29, endDate: null };
    expect(vorschauTermine(jaehrlich, 5)).toEqual(["2028-02-29", "2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29"]);
  });

  it("vierteljährlich und halbjährlich vom Monatsende", () => {
    const quartal = { nextDate: "2026-11-30", recurrence: "P3M" as const, anchorDay: 30, endDate: null };
    expect(vorschauTermine(quartal, 3)).toEqual(["2026-11-30", "2027-02-28", "2027-05-30"]);
    const halbjahr = { nextDate: "2026-08-31", recurrence: "P6M" as const, anchorDay: 31, endDate: null };
    expect(vorschauTermine(halbjahr, 3)).toEqual(["2026-08-31", "2027-02-28", "2027-08-31"]);
  });

  it("holt verpasste Termine nach, aber nicht über das Ende hinaus", () => {
    expect(faelligeTermine(monatlich("2026-08-01"), "2026-11-05")).toEqual(["2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"]);
    expect(faelligeTermine(monatlich("2026-08-01", 1, "2026-09-30"), "2026-11-05")).toEqual(["2026-08-01", "2026-09-01"]);
    expect(faelligeTermine(monatlich("2026-12-01"), "2026-11-05")).toEqual([]);
    // Am Tag des Termins ist er fällig
    expect(faelligeTermine(monatlich("2026-11-05"), "2026-11-05")).toEqual(["2026-11-05"]);
  });

  it("Vorschau endet am Enddatum", () => {
    expect(vorschauTermine(monatlich("2026-11-01", 1, "2027-01-15"), 12)).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
  });

  it("Folgetermin über den Jahreswechsel", () => {
    expect(folgeTermin("2026-12-31", { recurrence: "P1M", anchorDay: 31 })).toBe("2027-01-31");
    expect(folgeTermin("2026-11-15", { recurrence: "P1Y", anchorDay: 15 })).toBe("2027-11-15");
  });

  it("nach einer Pause: erster Termin am oder nach dem Stichtag", () => {
    expect(terminAbStichtag(monatlich("2026-06-01"), "2026-11-05")).toBe("2026-12-01");
    expect(terminAbStichtag(monatlich("2026-06-01"), "2026-11-01")).toBe("2026-11-01");
    expect(terminAbStichtag(monatlich("2027-01-01"), "2026-11-05")).toBe("2027-01-01");
    expect(terminAbStichtag(monatlich("2026-01-31"), "2026-02-10")).toBe("2026-02-28");
  });

  it("Periode ist der Monatserste, unabhängig vom Tag", () => {
    expect(dauerbelegPeriode("2026-11-03", "P1M")).toBe("2026-11-01");
    expect(dauerbelegPeriode("2028-02-29", "P1Y")).toBe("2028-02-01");
  });

  it("bei Wochen ist die Periode der Termin selbst, damit mehrere Belege im Monat entstehen (#1691)", () => {
    expect(dauerbelegPeriode("2026-11-03", "P1W")).toBe("2026-11-03");
    const woechentlich = { nextDate: "2026-11-23", recurrence: "P1W" as const, anchorDay: 23, endDate: null };
    const termine = faelligeTermine(woechentlich, "2027-01-04");
    expect(termine).toEqual(["2026-11-23", "2026-11-30", "2026-12-07", "2026-12-14", "2026-12-21", "2026-12-28", "2027-01-04"]);
    expect(new Set(termine.map((t) => dauerbelegPeriode(t, "P1W"))).size).toBe(termine.length);
    expect(folgeTermin("2026-12-28", { recurrence: "P2W", anchorDay: 28 })).toBe("2027-01-11");
    expect(vorschauTermine({ nextDate: "2026-12-14", recurrence: "P4W", anchorDay: 14, endDate: null }, 3)).toEqual(["2026-12-14", "2027-01-11", "2027-02-08"]);
    expect(terminAbStichtag({ nextDate: "2026-11-02", recurrence: "P2W", anchorDay: 2 }, "2026-11-20")).toBe("2026-11-30");
  });

  it("alle 2 Monate am Ankertag", () => {
    expect(vorschauTermine({ nextDate: "2026-12-31", recurrence: "P2M", anchorDay: 31, endDate: null }, 3)).toEqual(["2026-12-31", "2027-02-28", "2027-04-30"]);
  });

  it("Fälligkeit: Termin plus Tage, über Monats- und Jahresgrenzen", () => {
    expect(dauerbelegFaellig("2026-11-01", 0)).toBe("2026-11-01");
    expect(dauerbelegFaellig("2026-11-01", 3)).toBe("2026-11-04");
    expect(dauerbelegFaellig("2026-12-30", 3)).toBe("2027-01-02");
    expect(dauerbelegFaellig("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("Dauerbelege: Prüfung der Vorlage", () => {
  const vorlage = {
    nextDate: "2026-12-01",
    endDate: null,
    category: "sonstiges",
    amounts: [{ taxRate: 1900, net: 100000, tax: 19000 }],
    taxShown: true,
    kleinbetrag: false,
  };

  it("Kleinbetragsrechnung (#1101): Endbetrag mit Steuersatz bis 250 € je Termin, Haben teilt ihn auf (§ 33, § 35 Abs. 1 UStDV)", () => {
    const klein = { ...vorlage, taxShown: false, kleinbetrag: true };
    // 11,90 € zu 19 % → 10,00 € + 1,90 €
    expect(dauerbelegProbleme({ ...klein, amounts: [{ taxRate: 1900, net: 1000, tax: 190 }] })).toEqual([]);
    // Genau 250,00 € brutto ist erlaubt, ein Cent mehr nicht; die Grenze gilt für den Termin, über alle Sätze
    expect(dauerbelegProbleme({ ...klein, amounts: [{ taxRate: 1900, net: 21008, tax: 3992 }] })).toEqual([]);
    expect(dauerbelegProbleme({ ...klein, amounts: [{ taxRate: 1900, net: 21009, tax: 3992 }] })).toEqual([KLEINBETRAG_HINWEIS]);
    expect(
      dauerbelegProbleme({
        ...klein,
        amounts: [
          { taxRate: 1900, net: 16807, tax: 3193 },
          { taxRate: 700, net: 4674, tax: 327 },
        ],
      }),
    ).toEqual([KLEINBETRAG_HINWEIS]);
    // Netto und Steuer müssen die Aufteilung des Endbetrags sein, nicht frei gewählt
    expect(dauerbelegProbleme({ ...klein, amounts: [{ taxRate: 1900, net: 1100, tax: 90 }] })).toEqual([KLEINBETRAG_AUFTEILUNG]);
    // Nur eins von beidem: Steuerausweis oder Kleinbetragsrechnung
    expect(dauerbelegProbleme({ ...klein, taxShown: true, amounts: [{ taxRate: 1900, net: 1000, tax: 190 }] })).toEqual([
      "Entweder weist das Dokument die Steuer aus, oder es ist eine Kleinbetragsrechnung.",
    ]);
  });

  it("Vorsteuer nur mit Dokument mit Steuerausweis", () => {
    expect(dauerbelegProbleme(vorlage)).toEqual([]);
    expect(dauerbelegProbleme({ ...vorlage, taxShown: false })).toEqual([VORSTEUER_HINWEIS]);
    // Ohne Steuerausweis mit 0 %: in Ordnung (Wohnraummiete, Versicherung)
    expect(dauerbelegProbleme({ ...vorlage, taxShown: false, amounts: [{ taxRate: 0, net: 85000, tax: 0 }] })).toEqual([]);
  });

  it("Ende vor dem Termin, Anlagegut, leere Beträge, Gutschrift, Satz doppelt", () => {
    expect(dauerbelegProbleme({ ...vorlage, endDate: "2026-11-30" })).toContain("Das Ende liegt vor dem nächsten Termin.");
    expect(dauerbelegProbleme({ ...vorlage, category: "anlage" })[0]).toMatch(/Anlagegüter/);
    expect(dauerbelegProbleme({ ...vorlage, amounts: [] })).toContain("Beträge fehlen.");
    expect(dauerbelegProbleme({ ...vorlage, amounts: [{ taxRate: 1900, net: -100, tax: -19 }] })[0]).toMatch(/Gutschriften/);
    expect(
      dauerbelegProbleme({
        ...vorlage,
        amounts: [
          { taxRate: 1900, net: 1, tax: 0 },
          { taxRate: 1900, net: 2, tax: 0 },
        ],
      }),
    ).toContain("Jeder Steuersatz nur einmal.");
  });

  it("Summen", () => {
    expect(
      dauerbelegSummen([
        { taxRate: 1900, net: 100000, tax: 19000 },
        { taxRate: 0, net: 5000, tax: 0 },
      ]),
    ).toEqual({ net: 105000, tax: 19000, gross: 124000 });
  });
});
