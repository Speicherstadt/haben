import { describe, expect, it } from "vitest";
import { emptyLine, positionenFehler, positionsFehler } from "./editor-lines.ts";

const zeile = (patch: Partial<ReturnType<typeof emptyLine>>) => ({ ...emptyLine("Std.", 1900), ...patch });
const gueltig = { description: "Beratung", quantity: "2", unitPrice: "95,00" };
const ohneFehler = { beschreibung: null, menge: null, einzelpreis: null, rabatt: null };

describe("positionsFehler", () => {
  it("ist ohne Fehler für eine vollständige Position", () => {
    expect(positionsFehler(zeile(gueltig))).toEqual(ohneFehler);
  });

  it("nennt je Feld nur dessen Fehler", () => {
    expect(positionsFehler(zeile({ quantity: "0" }))).toEqual({
      beschreibung: "Trag die Beschreibung ein.",
      menge: "Trag eine Menge über 0 ein, etwa 2 oder 1,5.",
      einzelpreis: "Trag den Einzelpreis ein, etwa 95,00.",
      rabatt: null,
    });
    expect(positionsFehler(zeile({ ...gueltig, unitPrice: "" }))).toEqual({ ...ohneFehler, einzelpreis: "Trag den Einzelpreis ein, etwa 95,00." });
  });

  it("Beschreibung: Pflicht und höchstens 500 Zeichen wie der Server", () => {
    expect(positionsFehler(zeile({ ...gueltig, description: "   " })).beschreibung).toBe("Trag die Beschreibung ein.");
    expect(positionsFehler(zeile({ ...gueltig, description: ` ${"x".repeat(500)} ` })).beschreibung).toBeNull();
    expect(positionsFehler(zeile({ ...gueltig, description: "x".repeat(501) })).beschreibung).toBe("Kürz die Beschreibung auf höchstens 500 Zeichen.");
  });

  it("Menge: über 0, höchstens drei Nachkommastellen und bis 1.000.000 wie der Server", () => {
    const menge = (quantity: string) => positionsFehler(zeile({ ...gueltig, quantity })).menge;
    expect(menge("0,001")).toBeNull();
    expect(menge("1.000.000")).toBeNull();
    for (const falsch of ["", "0", "abc", "-1", "1,0005"]) expect(menge(falsch)).toBe("Trag eine Menge über 0 ein, etwa 2 oder 1,5.");
    expect(menge("1.000.000,001")).toBe("Trag eine Menge bis 1.000.000 ein.");
  });

  it("Einzelpreis: als Betrag lesbar, auch negativ, bis 100.000.000,00 wie der Server", () => {
    const preis = (unitPrice: string) => positionsFehler(zeile({ ...gueltig, unitPrice })).einzelpreis;
    expect(preis("0")).toBeNull();
    expect(preis("-50,00")).toBeNull();
    expect(preis("100.000.000,00")).toBeNull();
    expect(preis("-100.000.000,00")).toBeNull();
    expect(preis("12€50")).toBe("Trag den Einzelpreis ein, etwa 95,00.");
    const grenze = "Trag einen Einzelpreis von -100.000.000,00 bis 100.000.000,00 ein, etwa 95,00.";
    expect(preis("100.000.000,01")).toBe(grenze);
    expect(preis("-100.000.000,01")).toBe(grenze);
  });

  it("Rabatt: lesbar, nicht höher als die Position und als Betrag bis 100.000.000,00 wie der Server", () => {
    const rabatt = (patch: Partial<ReturnType<typeof emptyLine>>) => positionsFehler(zeile({ ...gueltig, ...patch })).rabatt;
    expect(rabatt({ discount: "10 %" })).toBeNull();
    expect(rabatt({ discount: "190,00" })).toBeNull();
    expect(rabatt({ discount: "abc" })).toBe("Rabatt als Prozent (z. B. 5 %) oder Betrag (z. B. 100,00).");
    expect(rabatt({ discount: "101 %" })).toBe("Rabatt als Prozent (z. B. 5 %) oder Betrag (z. B. 100,00).");
    expect(rabatt({ discount: "190,01" })).toBe("Der Rabatt ist höher als die Position.");
    expect(rabatt({ quantity: "2", unitPrice: "100.000.000,00", discount: "100.000.000,01" })).toBe(
      "Trag einen Rabatt bis 100.000.000,00 ein oder gib ihn in Prozent an.",
    );
  });

  it("Rabatt bleibt ohne Fehler, wo die Position keinen hat (Serienrechnung)", () => {
    expect(positionsFehler({ description: "Wartung {monat}", quantity: "1", unitPrice: "abc" })).toEqual({
      ...ohneFehler,
      einzelpreis: "Trag den Einzelpreis ein, etwa 95,00.",
    });
    expect(positionsFehler({ description: "Wartung {monat}", quantity: "1", unitPrice: "120,00" })).toEqual(ohneFehler);
  });
});

describe("positionenFehler", () => {
  it("gibt je Position und Feld einen eigenen Schlüssel für useSubmitCheck", () => {
    const erste = zeile({ ...gueltig, unitPrice: "" });
    const zweite = zeile({ quantity: "0", unitPrice: "10" });
    expect(positionenFehler([erste, zweite])).toEqual({
      [`pos-${erste.key}-beschreibung`]: null,
      [`pos-${erste.key}-menge`]: null,
      [`pos-${erste.key}-einzelpreis`]: "Trag den Einzelpreis ein, etwa 95,00.",
      [`pos-${erste.key}-rabatt`]: null,
      [`pos-${zweite.key}-beschreibung`]: "Trag die Beschreibung ein.",
      [`pos-${zweite.key}-menge`]: "Trag eine Menge über 0 ein, etwa 2 oder 1,5.",
      [`pos-${zweite.key}-einzelpreis`]: null,
      [`pos-${zweite.key}-rabatt`]: null,
    });
  });
});
