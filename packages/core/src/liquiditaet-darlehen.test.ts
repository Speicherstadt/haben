import { describe, expect, it } from "vitest";
import { darlehenRhythmus, darlehensPosten, type DarlehenVerlauf, type DarlehenZahlung } from "./liquiditaet-darlehen.ts";

const HEUTE = "2026-11-20";
/** Ende des Horizonts „6 Monate“ ab heute */
const BIS = "2027-05-19";

/** Rate am Tag: Tilgung und Zinsen in Cent, als Ausgang wie im Bankabgleich */
const rate = (datum: string, tilgung: number, zinsen = 0): DarlehenZahlung[] => [
  ...(tilgung ? [{ datum, teil: "tilgung" as const, betrag: -tilgung }] : []),
  ...(zinsen ? [{ datum, teil: "zins" as const, betrag: -zinsen }] : []),
];

const darlehen = (zahlungen: DarlehenZahlung[], bestand = 10_000_00): DarlehenVerlauf => ({ id: "d1", name: "Hausbank", bestand, zahlungen });

const posten = (d: DarlehenVerlauf, rest: { heute?: string; bis?: string; bankdatenAb?: string | null } = {}) =>
  darlehensPosten({ darlehen: d, heute: HEUTE, bis: BIS, bundesland: "BY", bankdatenAb: "2026-01-02", ...rest });

const kurz = (d: DarlehenVerlauf, rest?: Parameters<typeof posten>[1]) => posten(d, rest).posten.map((p) => [p.datum, p.betrag]);

describe("Rhythmus der Darlehensraten", () => {
  it("aus dem Abstand der letzten Raten, gerundet auf 1, 3, 6 oder 12 Monate; eine Rate gilt als monatlich", () => {
    expect(darlehenRhythmus(["2026-10-30"])).toBe(1);
    expect(darlehenRhythmus(["2026-09-30", "2026-11-02"])).toBe(1);
    expect(darlehenRhythmus(["2026-03-31", "2026-06-30", "2026-09-30"])).toBe(3);
    expect(darlehenRhythmus(["2025-09-30", "2026-03-31"])).toBe(6);
    expect(darlehenRhythmus(["2024-12-30", "2025-12-30"])).toBe(12);
    // Grenzen: 7 Wochen monatlich, 4 Monate vierteljährlich, 8 Monate halbjährlich, 10 Monate jährlich
    expect(darlehenRhythmus(["2026-01-05", "2026-02-23"])).toBe(1);
    expect(darlehenRhythmus(["2026-01-31", "2026-05-31"])).toBe(3);
    expect(darlehenRhythmus(["2026-01-31", "2026-09-30"])).toBe(6);
    expect(darlehenRhythmus(["2026-01-31", "2026-11-30"])).toBe(12);
    // Eine Rate außer der Reihe ändert den Rhythmus nicht: der häufigste der letzten drei Abstände
    expect(darlehenRhythmus(["2026-03-31", "2026-06-30", "2026-09-30", "2026-10-30"])).toBe(3);
  });
});

describe("Darlehensraten fortschreiben", () => {
  it("monatlich am 30. aus Tilgung und Zinsen, am Wochenende am nächsten Werktag, erwartet", () => {
    const d = darlehen([...rate("2026-09-30", 800_00, 200_00), ...rate("2026-10-30", 800_00, 200_00)]);
    const { posten: liste, hinweis } = posten(d);
    expect(hinweis).toBeNull();
    // 30.01.2027 ist ein Samstag, 28.02.2027 ein Sonntag
    expect(liste.map((p) => [p.datum, p.betrag])).toEqual([
      ["2026-11-30", 1000_00],
      ["2026-12-30", 1000_00],
      ["2027-02-01", 1000_00],
      ["2027-03-01", 1000_00],
      ["2027-03-30", 1000_00],
      ["2027-04-30", 1000_00],
    ]);
    expect(liste[0]).toEqual({
      datum: "2026-11-30",
      betrag: 1000_00,
      richtung: "aus",
      text: "Hausbank, Rate wie zuletzt gezahlt",
      quelle: { art: "darlehen", id: "d1" },
      sicherheit: "erwartet",
    });
  });

  it("vierteljährlich zum Monatsende", () => {
    const d = darlehen([...rate("2026-03-31", 1500_00, 400_00), ...rate("2026-06-30", 1500_00, 380_00), ...rate("2026-09-30", 1500_00, 360_00)]);
    // Zinsen sinken mit jeder Rate: keiner doppelt, also der mittlere
    expect(kurz(d)).toEqual([
      ["2026-12-31", 1880_00],
      ["2027-03-31", 1880_00],
    ]);
  });

  it("zum 31.: der 29. Februar verschiebt den Tag nicht, auch nicht bei nur zwei Raten", () => {
    const zwei = darlehen([...rate("2028-01-31", 500_00, 50_00), ...rate("2028-02-29", 500_00, 50_00)]);
    // 30.04.2028 ist ein Sonntag, der 1. Mai ein Feiertag
    expect(kurz(zwei, { heute: "2028-03-05", bis: "2028-05-31" })).toEqual([
      ["2028-03-31", 550_00],
      ["2028-05-02", 550_00],
      ["2028-05-31", 550_00],
    ]);
  });

  it("eine wegen des Wochenendes erst im Folgemonat abgebuchte Rate gehört zum Termin davor", () => {
    // Die Rate zum 31.10.2026 (Samstag) bucht die Bank am Montag, dem 2. November, ab: Die Rate zum 30.11. steht trotzdem
    const d = darlehen([...rate("2026-08-31", 800_00, 200_00), ...rate("2026-09-30", 800_00, 200_00), ...rate("2026-11-02", 800_00, 200_00)]);
    expect(kurz(d, { bis: "2026-12-31" })).toEqual([
      ["2026-11-30", 1000_00],
      ["2026-12-31", 1000_00],
    ]);
  });

  it("der Tag im Monat ist der Termin, nicht der wegen Wochenende oder Feiertag spätere Buchungstag", () => {
    // Zum Monatsende: Der 31.01. und der 28.02.2026 sind Samstage, die Bank bucht am 02.02. und 02.03. ab
    const monatsende = darlehen([...rate("2026-02-02", 800_00, 200_00), ...rate("2026-03-02", 800_00, 200_00), ...rate("2026-03-31", 800_00, 200_00)]);
    expect(kurz(monatsende, { heute: "2026-04-10", bis: "2026-07-31" }).map(([datum]) => datum)).toEqual([
      "2026-04-30",
      "2026-06-01",
      "2026-06-30",
      "2026-07-31",
    ]);
    // Zum 1.: Neujahr und der Sonntag, 01.02.2026, schieben die Abbuchung auf den 2.
    const erster = darlehen([...rate("2025-12-01", 800_00, 200_00), ...rate("2026-01-02", 800_00, 200_00), ...rate("2026-02-02", 800_00, 200_00)]);
    expect(kurz(erster, { heute: "2026-02-10", bis: "2026-06-30" }).map(([datum]) => datum)).toEqual(["2026-03-02", "2026-04-01", "2026-05-04", "2026-06-01"]);
    // Zum 15.: Der 15.02. und 15.03.2026 sind Sonntage
    const mitte = darlehen([...rate("2026-02-16", 800_00, 200_00), ...rate("2026-03-16", 800_00, 200_00), ...rate("2026-04-15", 800_00, 200_00)]);
    expect(kurz(mitte, { heute: "2026-04-20", bis: "2026-07-31" }).map(([datum]) => datum)).toEqual(["2026-05-15", "2026-06-15", "2026-07-15"]);
  });

  it("Tilgungen enden am Bestand, die letzte tilgt den Rest und heißt Schlussrate", () => {
    const d = darlehen([...rate("2026-09-30", 800_00, 20_00), ...rate("2026-10-30", 800_00, 20_00)], 2000_00);
    const liste = posten(d).posten;
    expect(liste.map((p) => [p.datum, p.betrag, p.text])).toEqual([
      ["2026-11-30", 820_00, "Hausbank, Rate wie zuletzt gezahlt"],
      ["2026-12-30", 820_00, "Hausbank, Rate wie zuletzt gezahlt"],
      ["2027-02-01", 420_00, "Hausbank, Schlussrate"],
    ]);
    // Getilgt: kein Bestand, keine Rate, auch keine Zinsen
    expect(posten(darlehen(d.zahlungen as DarlehenZahlung[], 0))).toEqual({ posten: [], hinweis: null });
  });

  it("nur Zinsen (endfälliges Darlehen): ohne Kappung bis zum Ende des Horizonts", () => {
    const d = darlehen([...rate("2026-06-30", 0, 300_00), ...rate("2026-09-30", 0, 300_00)], 50_000_00);
    // 30.06. und 30.09. sind Monatsenden: weiter zum Monatsende
    expect(kurz(d, { bis: "2027-12-31" })).toEqual([
      ["2026-12-31", 300_00],
      ["2027-03-31", 300_00],
      ["2027-06-30", 300_00],
      ["2027-09-30", 300_00],
      ["2027-12-31", 300_00],
    ]);
  });

  it("eine Sondertilgung wird nicht fortgeschrieben, am Tag einer Rate wie an einem eigenen Tag", () => {
    // Zum Monatsende; der 31.10.2026 ist ein Samstag
    const amSelbenTag = darlehen([...rate("2026-08-31", 800_00, 200_00), ...rate("2026-09-30", 800_00, 200_00), ...rate("2026-11-02", 5800_00, 200_00)]);
    expect(kurz(amSelbenTag, { bis: "2026-12-31" })).toEqual([
      ["2026-11-30", 1000_00],
      ["2026-12-31", 1000_00],
    ]);
    // Eigener Tag ohne Zinsen: keine Rate, der Rhythmus bleibt beim 30.
    const eigenerTag = darlehen([...rate("2026-09-30", 800_00, 200_00), ...rate("2026-10-30", 800_00, 200_00), ...rate("2026-11-15", 5000_00)]);
    expect(kurz(eigenerTag, { bis: "2026-12-31" })).toEqual([
      ["2026-11-30", 1000_00],
      ["2026-12-30", 1000_00],
    ]);
    // Vierteljährlich mit Sondertilgung dazwischen: Der kurze Abstand zur Sondertilgung macht die Rate nicht monatlich
    const quartal = darlehen([...rate("2026-06-30", 1500_00, 300_00), ...rate("2026-09-30", 1500_00, 300_00), ...rate("2026-10-15", 5000_00)]);
    expect(kurz(quartal)).toEqual([
      ["2026-12-31", 1800_00],
      ["2027-03-31", 1800_00],
    ]);
  });

  it("Gebühren und Auszahlung zählen nicht zur Rate", () => {
    const d = darlehen([
      { datum: "2026-09-01", teil: "auszahlung", betrag: 10_000_00 },
      { datum: "2026-09-01", teil: "gebuehr", betrag: -150_00 },
      ...rate("2026-09-30", 800_00, 200_00),
      { datum: "2026-10-30", teil: "gebuehr", betrag: -10_00 },
      ...rate("2026-10-30", 800_00, 200_00),
    ]);
    expect(kurz(d, { bis: "2026-11-30" })).toEqual([["2026-11-30", 1000_00]]);
  });

  it("nur eine Rate: monatlich angenommen und geschätzt", () => {
    const liste = posten(darlehen(rate("2026-11-02", 700_00, 100_00)), { bis: "2027-01-10" }).posten;
    expect(liste.map((p) => [p.datum, p.betrag, p.sicherheit, p.text])).toEqual([
      ["2026-12-02", 800_00, "geschaetzt", "Hausbank, Rate wie zuletzt gezahlt, monatlich angenommen"],
      ["2027-01-04", 800_00, "geschaetzt", "Hausbank, Rate wie zuletzt gezahlt, monatlich angenommen"],
    ]);
  });

  it("ruhend: nach zwei Intervallen und 30 Tagen ohne Rate steht nichts mehr", () => {
    // Letzte Rate 30.07.: 30.09. plus 30 Tage liegt vor heute
    const ruhend = darlehen([...rate("2026-06-30", 800_00, 200_00), ...rate("2026-07-30", 800_00, 200_00)]);
    expect(posten(ruhend)).toEqual({ posten: [], hinweis: null });
    // Letzte Rate zum Monatsende August: 31.10. plus 30 Tage ist der 30.11., also noch nicht ruhend; der 31.10. ist ein Samstag
    const knapp = darlehen([...rate("2026-07-31", 800_00, 200_00), ...rate("2026-08-31", 800_00, 200_00)]);
    expect(kurz(knapp, { bis: "2026-11-30" })).toEqual([
      ["2026-09-30", 1000_00],
      ["2026-11-02", 1000_00],
      ["2026-11-30", 1000_00],
    ]);
  });

  it("überfällig nur nach dem ersten Bankumsatz, ohne Bankumsätze nie", () => {
    const d = darlehen([...rate("2026-08-31", 800_00, 200_00), ...rate("2026-09-30", 800_00, 200_00)]);
    // Rate zum 31.10. (Samstag) am Montag, dem 2. November
    expect(kurz(d, { bis: "2026-11-30" })).toEqual([
      ["2026-11-02", 1000_00],
      ["2026-11-30", 1000_00],
    ]);
    expect(kurz(d, { bis: "2026-11-30", bankdatenAb: "2026-11-02" })).toEqual([["2026-11-30", 1000_00]]);
    expect(kurz(d, { bis: "2026-11-30", bankdatenAb: null })).toEqual([["2026-11-30", 1000_00]]);
  });

  it("ohne Rate ein Hinweis, mit Bestand; nur Gebühren sind keine Rate", () => {
    expect(posten(darlehen([]))).toEqual({ posten: [], hinweis: "Für das Darlehen „Hausbank“ ist noch keine Rate zugeordnet; sie fehlt in der Vorschau." });
    expect(posten(darlehen([{ datum: "2026-10-01", teil: "gebuehr", betrag: -50_00 }])).hinweis).not.toBeNull();
    expect(posten(darlehen([], 0))).toEqual({ posten: [], hinweis: null });
  });
});
