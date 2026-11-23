import { describe, expect, it } from "vitest";
import { readWisoAssetRegister } from "./anlagenregister.ts";

const heading = "Nr   Bezeichnung   Anschaffungs-   Anschaffungs-   Zugänge /   ND   AfA   RBW   AfA   RBW   Anlagen-";
const subheading = "datum   kosten   Teilabgänge   Vorjahre   Vorjahr   2026   31.12.2026   abgang";
const title = "Verzeichnis der abnutzbaren Anlagegüter 2026";
const page = (...lines: string[]) => [title, heading, subheading, ...lines].join("\n");

describe("WISO-EÜR-Anlagenverzeichnis", () => {
  it("erfasst Anlagewerte und führt eine Kontengruppe auf der nächsten Seite fort", () => {
    const data = readWisoAssetRegister([
      page("410 Geschäftsausstattung", "  008 Kaffeemaschine   27.12.2016   588,19   3   588,19   0,00   0,00   0,00"),
      page(
        "  159 Multifunktionsdrucker mit langer Bezeichnung16.11.2022  2.515,95  1  2.515,95  0,00  0,00  0,00",
        "Summen  3.104,14  3.104,14  0,00  0,00  0,00",
      ),
      "Anlagendetails 2026\nNr. 159\nAnschaffungskosten: 2.515,95 Euro",
    ]);
    expect(data.year).toBe(2026);
    expect(data.assets).toMatchObject([
      { inventoryNumber: "008", account: "410", cost: 58819, closingBookValue: 0, page: 1 },
      { inventoryNumber: "159", account: "410", name: "Multifunktionsdrucker mit langer Bezeichnung", acquisitionDate: "2022-11-16", cost: 251595, page: 2 },
    ]);
    expect(data.warnings).toEqual([]);
  });

  it("meldet eine Summenabweichung sowie Zugang und Abgang, ohne Werte oder Methode zu verändern", () => {
    const data = readWisoAssetRegister([
      page(
        "480 GWG bis 800 €",
        "  213 Laptop   11.02.2026   487,39    50,00   1   0,00   0,00   447,39   40,00   30.12.2026",
        "Summen  486,39  50,00  0,00  0,00  447,39  40,00",
      ),
    ]);
    expect(data.assets[0]).toMatchObject({ inventoryNumber: "213", cost: 48739, change: 5000, disposalDate: "2026-12-30", closingBookValue: 4000 });
    expect(data.warnings).toEqual([expect.stringContaining("213"), expect.stringContaining("480")]);
  });

  it("verwirft fremde Dokumente, unlesbare Zeilen und doppelte Inventarnummern", () => {
    const row = "  1 Stuhl   01.02.2024   300,00   13   20,00   280,00   20,00   260,00";
    expect(() => readWisoAssetRegister(["Kaufbeleg Bürostuhl"])).toThrow(/Anlagenverzeichnis/);
    expect(() => readWisoAssetRegister([page("410 Geschäftsausstattung", "  4 unlesbare Buchwerte")])).toThrow(/Seite 1/);
    expect(() => readWisoAssetRegister([page("410 Geschäftsausstattung", row, row)])).toThrow(/Inventarnummer 1/);
    expect(() => readWisoAssetRegister([page("410 Geschäftsausstattung", row)])).toThrow(/Summenzeile für Konto 410 fehlt/);
    expect(() => readWisoAssetRegister([page("410 Geschäftsausstattung", "16 Defekte Zeile 01.02.2024 25,00")])).toThrow(/nicht eindeutig lesbar/);
    const noName = "  17     01.02.2024  300,00  13  20,00  280,00  20,00  260,00";
    expect(() => readWisoAssetRegister([page("410 Geschäftsausstattung", noName)])).toThrow(/nicht eindeutig lesbar/);
  });

  it("weist auf fehlende Seiten und einen abweichenden Restbuchwert in der Summe hin", () => {
    const row = "  1 Stuhl   01.02.2024   300,00   13   20,00   280,00   20,00   260,00";
    const subtotal = "Summen 300,00 20,00 280,00 20,00 261,00";
    expect(() => readWisoAssetRegister([`Unternehmen / Firma Test   Seite 2\n${page("410 Geschäftsausstattung", row, subtotal)}`])).toThrow(/fehlende Seiten/);
    expect(readWisoAssetRegister([page("410 Geschäftsausstattung", row, subtotal)]).warnings[0]).toContain("Restbuchwert 31.12.");
  });
});
