import { manualPostingFindings, type ManualLine, parseEuro } from "@haben/core";
import { describe, expect, it } from "vitest";
import { buchungsFehler, kontoSuchfehler } from "./-buchungs-pruefung.ts";
import { emptyRow, type Row } from "./-buchungs-zeile.tsx";

// #1277: Fehler einer Zeile am Feld, Meldungen zur ganzen Buchung erst, wenn die Zeilen stimmen
describe("Prüfung der manuellen Buchung je Feld", () => {
  const zeile = (key: number, patch: Partial<Row>): Row => ({ ...emptyRow(key), ...patch });
  const betrag = (text: string) => (text.trim() === "" ? 0 : (parseEuro(text) ?? Number.NaN));
  const pruefen = (rows: Row[]) => {
    const lines: ManualLine[] = rows.map((r) => ({ account: r.account, debit: betrag(r.debit), credit: betrag(r.credit), taxCode: null }));
    const { zellen, buchung } = buchungsFehler(rows, [...kontoSuchfehler(rows), ...manualPostingFindings(lines, "SKR04", "gmbh")]);
    return { fehler: Object.fromEntries(Object.entries(zellen).filter(([, e]) => e !== null)), buchung };
  };

  it("nimmt eine stimmige Buchung an und hat für jedes Feld jeder Zeile einen Schlüssel", () => {
    const rows = [zeile(1, { account: "3510", debit: "100,00" }), zeile(7, { account: "2900", credit: "100,00" })];
    expect(pruefen(rows)).toEqual({ fehler: {}, buchung: [] });
    expect(Object.keys(buchungsFehler(rows, []).zellen)).toEqual([
      "1.account",
      "1.debit",
      "1.credit",
      "1.taxCode",
      "7.account",
      "7.debit",
      "7.credit",
      "7.taxCode",
    ]);
  });

  it("meldet Konto und nicht lesbaren Betrag am Feld der Zeile, die Summe erst danach", () => {
    const rows = [zeile(1, { account: "12", debit: "100,00" }), zeile(2, { account: "2900", credit: "zehn" })];
    expect(pruefen(rows)).toEqual({
      fehler: { "1.account": "Konto hat vier Ziffern.", "2.credit": "Trag den Betrag im Haben ein, etwa 100,00, oder lass das Feld leer." },
      buchung: [],
    });
  });

  it("nennt, was die ganze Buchung betrifft, sobald die Zeilen stimmen", () => {
    const rows = [zeile(1, { account: "3510", debit: "100,00" }), zeile(2, { account: "2900", credit: "50,00" })];
    expect(pruefen(rows)).toEqual({ fehler: {}, buchung: ["Soll und Haben sind nicht gleich."] });
  });

  it("legt „Betrag entweder im Soll oder im Haben“ ans Soll und „Betrag ungültig“ an die Seite mit dem Fehler", () => {
    expect(pruefen([zeile(1, { account: "3510" }), zeile(2, { account: "2900", credit: "-5,00" })]).fehler).toEqual({
      "1.debit": "Betrag entweder im Soll oder im Haben.",
      "2.credit": "Betrag ungültig.",
    });
  });

  it("nimmt bei einer Namenseingabe ohne Auswahl den Hinweis der Kontosuche statt „vier Ziffern“", () => {
    const rows = [zeile(1, { accountText: "Unbekanntes Konto", debit: "100,00" }), zeile(2, { account: "2900", credit: "100,00" })];
    expect(pruefen(rows).fehler).toEqual({ "1.account": "Konto nicht gefunden; aus der Liste wählen oder die Nummer eingeben." });
  });
});
