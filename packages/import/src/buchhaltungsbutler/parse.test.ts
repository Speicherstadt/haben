import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { previewBuchhaltungsbutlerExport } from "./parse.ts";
import { readExportFiles } from "./export-files.ts";
import type { ExportPart } from "./export-files.ts";

const BB_HEADERS = [
  "Datum",
  "Buchungstext",
  "Betrag",
  "Währung",
  "Sollkonto",
  "Habenkonto",
  "Steuerschlüssel",
  "Buchungsnummer",
  "Rechnungsnummern",
  "Gegenpartei",
  "Umsatzsteuer",
  "Zugewiesene Beträge",
  "Beleglinks",
  "Festschreibung",
  "Kommentar",
  "Leistungsdatum",
  "Beleg-Dateinamen",
] as const;

const DATEV_HEADERS = [
  "Umsatz (ohne Soll/Haben-Kz)",
  "Soll/Haben-Kennzeichen",
  "WKZ Umsatz",
  "Konto",
  "Gegenkonto (ohne BU-Schlüssel)",
  "BU-Schlüssel",
  "Belegdatum",
  "Belegfeld 1",
  "Buchungstext",
  ...Array.from({ length: 16 }, (_, i) => `Beleginfo - ${i % 2 === 0 ? "Art" : "Inhalt"} ${Math.floor(i / 2) + 1}`),
] as const;

interface TestRow {
  id: string;
  amount?: string;
  debit: string;
  credit: string;
  side?: "S" | "H";
  bu?: string;
  number?: string;
  contact?: string;
  documentDate?: string;
  rate?: string;
  /** Spalte „Beleg-Dateinamen“ des BB Standardexports */
  names?: string;
  /** Beleginfo „Original-Dateiname“ im DATEV-Buchungsstapel */
  original?: string;
  url?: string;
}

function csv(rows: (readonly string[])[]): Uint8Array {
  const text = rows.map((row) => row.map((field) => `"${field.replaceAll('"', '""')}"`).join(";")).join("\r\n");
  return new TextEncoder().encode(text);
}

function makeParts(rows: TestRow[], pdfIds = rows.filter((row) => row.number).map((row) => row.id)): ExportPart[] {
  const datevRows: string[][] = [meta(), [...DATEV_HEADERS]];
  const bbRows: string[][] = [[...BB_HEADERS]];
  const receipts: Record<string, Uint8Array> = {};
  for (const row of rows) {
    const amount = row.amount ?? "119,00";
    const rate = row.rate ?? "19";
    const documentDate = row.documentDate ?? "02.01.2023";
    const contact = row.contact ?? "Muster GmbH";
    const side = row.side ?? "H";
    const account = side === "S" ? row.debit : row.credit;
    const contra = side === "S" ? row.credit : row.debit;
    const info: string[] = [];
    const addInfo = (name: string, value: string) => info.push(name, value);
    addInfo("Buchungsnummer", row.id);
    if (row.number) {
      addInfo("URL", row.url ?? `https://bb.example/${row.number}.pdf`);
      addInfo("Gegenpartei", contact);
      addInfo("Rechnungsnummer", row.number);
      addInfo("Betrag", amount);
      addInfo("Umsatzsteuer", rate);
      addInfo("Rechnungsdatum", documentDate);
      if (row.original) addInfo("Original-Dateiname", row.original);
    }
    datevRows.push([amount, side, "EUR", account, contra, row.bu ?? "9", "0401", row.number ?? "", contact, ...info]);
    bbRows.push([
      "04.01.2023",
      contact,
      amount,
      "EUR",
      row.debit,
      row.credit,
      row.bu ?? "9",
      row.id,
      row.number ?? "",
      contact,
      rate,
      amount,
      row.number ? `https://bb.example/${row.number}.pdf` : "",
      "1",
      "",
      documentDate,
      row.names ?? "",
    ]);
    if (pdfIds.includes(row.id)) receipts[`Belege/${row.id}.pdf`] = new TextEncoder().encode("%PDF-1.4\n%%EOF");
  }
  return [
    { name: "EXTF_Buchungsstapel.csv", bytes: csv(datevRows) },
    { name: "BB_Buchungsstapel.csv", bytes: csv(bbRows) },
    { name: "Belege.zip", bytes: zipSync(receipts) },
  ];
}

function meta(): string[] {
  const fields = Array.from({ length: 30 }, () => "");
  fields[0] = "EXTF";
  fields[1] = "700";
  fields[2] = "21";
  fields[3] = "Buchungsstapel";
  fields[4] = "12";
  fields[12] = "20230101";
  fields[13] = "4";
  fields[14] = "20230101";
  fields[15] = "20231231";
  fields[21] = "EUR";
  fields[26] = "03";
  return fields;
}

describe("BuchhaltungsButler-Export", () => {
  it("mappt eine Ausgabe mit Rechnungsdatum und PDF", () => {
    const result = previewBuchhaltungsbutlerExport(makeParts([{ id: "127", number: "202300327", debit: "4964", credit: "1203", amount: "67,79" }]), "SKR03");
    expect(result.bookings).toBe(1);
    expect(result.files).toBe(1);
    expect(result.vouchers[0]).toMatchObject({
      bookingId: "127",
      voucher: {
        lexofficeId: "booking/2023/127",
        type: "purchaseinvoice",
        direction: "ausgabe",
        number: "202300327",
        date: "2023-01-02",
        net: 5697,
        tax: 1082,
        gross: 6779,
        taxes: [{ rate: 1900, net: 5697, tax: 1082 }],
      },
    });
    expect(result.vouchers[0]?.files[0]?.filename).toBe("127.pdf");
  });

  it("mappt Gutschrift, Anlagekauf und Geldtransit", () => {
    const result = previewBuchhaltungsbutlerExport(
      makeParts([
        { id: "1", number: "G-1", debit: "8400", credit: "1203", side: "S", bu: "3" },
        { id: "2", number: "A-1", debit: "0420", credit: "1204" },
        { id: "3", number: "E-1", debit: "1204", credit: "1360" },
      ]),
      "SKR03",
    );
    expect(result.vouchers.map((item) => [item.voucher.type, item.voucher.gross, item.voucher.tax, item.neutral])).toEqual([
      ["creditnote", -11900, -1900, false],
      ["purchaseinvoice", 11900, 1900, false],
      ["invoice", 11900, 0, true],
    ]);
  });

  it("mappt Einnahmen und Ausgaben auch mit SKR04", () => {
    const result = previewBuchhaltungsbutlerExport(
      makeParts([
        { id: "1", number: "G-1", debit: "4400", credit: "1203", side: "S", bu: "3" },
        { id: "2", number: "A-1", debit: "5400", credit: "1203" },
      ]),
      "SKR04",
    );
    expect(result.vouchers.map((item) => item.voucher.type)).toEqual(["creditnote", "purchaseinvoice"]);
  });

  it("lässt Buchungen ohne Beleg aus und liest mehrere PDFs", () => {
    const parts = makeParts([
      { id: "97", number: "R-97", debit: "4964", credit: "1203" },
      { id: "98", debit: "1203", credit: "8400", side: "S", bu: "0" },
    ]);
    parts[2] = {
      name: "Belege.zip",
      bytes: zipSync({
        "Belege/97_1.pdf": new TextEncoder().encode("%PDF-1.4\n1"),
        "Belege/97_2.pdf": new TextEncoder().encode("%PDF-1.4\n2"),
      }),
    };
    const result = previewBuchhaltungsbutlerExport(parts, "SKR03");
    expect(result.bookings).toBe(2);
    expect(result.vouchers).toHaveLength(1);
    expect(result.files).toBe(2);
    expect(result.withoutReceipt).toBe(1);
    expect(result.multipleFiles).toBe(1);
  });

  it("übernimmt eine E-Rechnung als XML", () => {
    const parts = makeParts([{ id: "1831", number: "R-1831", debit: "4964", credit: "1203" }]);
    parts[2] = {
      name: "Belege.zip",
      bytes: zipSync({ "Belege/1831.xml": new TextEncoder().encode('<?xml version="1.0"?><rsm:CrossIndustryInvoice />') }),
    };
    const result = previewBuchhaltungsbutlerExport(parts, "SKR03");
    expect(result.vouchers[0]?.files[0]).toMatchObject({ filename: "1831.xml", role: "xml" });
  });

  it("liest das äußere datenexport.zip", () => {
    const parts = makeParts([{ id: "127", number: "R-127", debit: "4964", credit: "1203" }]);
    const outer = zipSync(Object.fromEntries(parts.map((part) => [part.name, part.bytes])));
    const files = readExportFiles([{ name: "datenexport.zip", bytes: outer }]);
    expect(new TextDecoder().decode(files.datev)).toContain("EXTF");
    expect(new TextDecoder().decode(files.bb)).toContain("Buchungsnummer");
  });

  it("bricht bei Abweichungen zwischen BB und DATEV ab", () => {
    const parts = makeParts([{ id: "127", number: "R-127", debit: "4964", credit: "1203" }]);
    const rows = [
      BB_HEADERS,
      ["04.01.2023", "Muster", "68,00", "EUR", "4964", "1203", "9", "127", "R-127", "Muster", "19", "68,00", "url", "1", "", "02.01.2023"],
    ];
    parts[1] = { name: "BB_Buchungsstapel.csv", bytes: csv(rows) };
    expect(() => previewBuchhaltungsbutlerExport(parts, "SKR03")).toThrow("weichen ab");
  });

  it("bricht bei fehlendem PDF ab", () => {
    const parts = makeParts([{ id: "127", number: "R-127", debit: "4964", credit: "1203" }], []);
    expect(() => previewBuchhaltungsbutlerExport(parts, "SKR03")).toThrow("PDF fehlt");
  });

  it("bricht bei unklarer Kontenrichtung ab", () => {
    const parts = makeParts([{ id: "127", number: "R-127", debit: "2000", credit: "2001" }]);
    expect(() => previewBuchhaltungsbutlerExport(parts, "SKR03")).toThrow("nicht eindeutig");
  });

  it("übernimmt Erlöse, Zahlungen, Geldtransit und Umbuchungen ohne Beleg nicht ins Archiv der Belege", () => {
    const result = previewBuchhaltungsbutlerExport(
      makeParts([
        { id: "1", number: "R-1", debit: "10000", credit: "8400", side: "S", bu: "" },
        { id: "2", debit: "1200", credit: "10000", side: "S", bu: "" },
        { id: "3", debit: "1360", credit: "1200", side: "S", bu: "" },
        { id: "4", debit: "2000", credit: "2001", side: "S", bu: "" },
        { id: "5", debit: "1200", credit: "8400", side: "S", bu: "" },
      ]),
      "SKR03",
    );
    expect(result.bookings).toBe(5);
    expect(result.vouchers.map((item) => item.bookingId)).toEqual(["1"]);
    expect(result.vouchers[0]?.raw).toMatchObject({ taxType: "net" });
  });

  it("nimmt die Richtung aus dem Steuerschlüssel, wenn der GuV-Posten sie nicht zeigt", () => {
    const result = previewBuchhaltungsbutlerExport(
      makeParts([
        // Erlöse aus Anlagenverkäufen bei Buchverlust (SKR03 8800 ff.) stehen in der GuV unter den sonstigen Aufwendungen
        { id: "1", number: "A-1", debit: "1200", credit: "8801", side: "S", bu: "3" },
        // Wareneinkauf auf das Bestandskonto Waren (SKR03 3980) über den Kreditor
        { id: "2", number: "W-2", debit: "3980", credit: "70000", side: "S", bu: "9" },
      ]),
      "SKR03",
    );
    expect(result.vouchers.map((item) => [item.voucher.type, item.voucher.gross, item.voucher.tax, item.neutral])).toEqual([
      ["invoice", 11900, 1900, false],
      ["purchaseinvoice", 11900, 1900, false],
    ]);
  });
});

// Belege unter ihrem Originalnamen (#1828); Namen und Werte erfunden
describe("BuchhaltungsButler: Belege über den Dateinamen", () => {
  const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n${text}`);
  const verzeichnis = new TextEncoder().encode(
    '<?xml version="1.0" encoding="utf-8"?><archive xmlns="http://xml.datev.de/bedi/tps/document/v04.0" version="4.0"></archive>',
  );
  const buchung = (id: string, extra: Partial<TestRow> = {}): TestRow => ({ id, number: `R-${id}`, debit: "4964", credit: "1203", ...extra });
  const vorschau = (rows: TestRow[], zip: Record<string, Uint8Array>) => {
    const parts = makeParts(rows, []);
    parts[2] = { name: "Belege.zip", bytes: zipSync(zip) };
    return previewBuchhaltungsbutlerExport(parts, "SKR03");
  };
  const dateien = (result: ReturnType<typeof vorschau>) => result.vouchers.map((v) => v.files.map((f) => f.filename));

  it("ordnet Originalnamen zu und hält die document.xml des Belegtransfers nicht für einen Beleg", () => {
    const result = vorschau([buchung("1", { names: "Rechnung-A.pdf" }), buchung("2", { names: "Beleg B.pdf" })], {
      "Belege/Rechnung-A.pdf": pdf("a"),
      "Belege/Beleg B.pdf": pdf("b"),
      "Belege/document.xml": verzeichnis,
    });
    expect(dateien(result)).toEqual([["Rechnung-A.pdf"], ["Beleg B.pdf"]]);
    expect(result.files).toBe(2);
  });

  it("hängt eine Datei an jede Buchung, die sie nennt", () => {
    const result = vorschau([buchung("1", { names: "Sammel.pdf" }), buchung("2", { names: "Sammel.pdf" })], { "Sammel.pdf": pdf("s") });
    expect(dateien(result)).toEqual([["Sammel.pdf"], ["Sammel.pdf"]]);
  });

  it("trennt zwei Dateien in einem Feld am Komma", () => {
    const result = vorschau([buchung("1", { names: "a.pdf, b.pdf" })], { "a.pdf": pdf("a"), "b.pdf": pdf("b") });
    expect(dateien(result)).toEqual([["a.pdf", "b.pdf"]]);
    expect(result.multipleFiles).toBe(1);
  });

  it("nimmt einen Namen mit Komma als Ganzes, wenn er so im ZIP liegt", () => {
    const result = vorschau([buchung("1", { names: "Miete, Mai.pdf" })], { "Miete, Mai.pdf": pdf("m") });
    expect(dateien(result)).toEqual([["Miete, Mai.pdf"]]);
  });

  it("nimmt ohne „Beleg-Dateinamen“ den „Original-Dateiname“ aus dem DATEV-Stapel", () => {
    const result = vorschau([buchung("1", { original: "Original.pdf" })], { "Original.pdf": pdf("o") });
    expect(dateien(result)).toEqual([["Original.pdf"]]);
  });

  it("nimmt ohne beide den Namen vom Ende der Beleg-URL, ohne Abfrage und dekodiert", () => {
    const result = vorschau([buchung("1", { url: "https://bb.example/belege/Quittung%20Mai.pdf?sig=abc" })], { "Quittung Mai.pdf": pdf("q") });
    expect(dateien(result)).toEqual([["Quittung Mai.pdf"]]);
  });

  it("nennt eine fehlende Datei beim Namen", () => {
    expect(() => vorschau([buchung("1", { names: "a.pdf, fehlt.pdf" })], { "a.pdf": pdf("a") })).toThrow("PDF fehlt in Belege.zip (gesucht: fehlt.pdf)");
  });

  it("nennt eine Datei, die zu keiner Buchung gehört, beim Namen", () => {
    expect(() => vorschau([buchung("1", { names: "a.pdf" })], { "a.pdf": pdf("a"), "zuviel.pdf": pdf("z") })).toThrow("„zuviel.pdf“ gehört zu keiner Buchung");
  });

  it("hält eine andere document.xml für einen Beleg", () => {
    const rechnung = new TextEncoder().encode('<?xml version="1.0"?><rsm:CrossIndustryInvoice />');
    const result = vorschau([buchung("1", { names: "document.xml" })], { "document.xml": rechnung });
    expect(dateien(result)).toEqual([["document.xml"]]);
  });
});

// TDD-Review zu #1830; Namen und Werte erfunden
describe("BuchhaltungsButler: Belegzuordnung, Randfälle", () => {
  const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n${text}`);
  const buchung = (id: string, extra: Partial<TestRow> = {}): TestRow => ({ id, number: `R-${id}`, debit: "4964", credit: "1203", ...extra });
  const vorschau = (rows: TestRow[], zip: Record<string, Uint8Array>) => {
    const parts = makeParts(rows, []);
    parts[2] = { name: "Belege.zip", bytes: zipSync(zip) };
    return previewBuchhaltungsbutlerExport(parts, "SKR03");
  };
  const dateien = (result: ReturnType<typeof vorschau>) => result.vouchers.map((v) => v.files.map((f) => f.filename));

  it("hängt statt einer fehlenden Datei nicht die Datei einer anderen Buchung an, die wie die Buchungsnummer heißt", () => {
    expect(() => vorschau([buchung("12", { names: "Lieferant.pdf" }), buchung("40", { names: "12.pdf" })], { "12.pdf": pdf("von 40") })).toThrow(
      "Lieferant.pdf",
    );
  });

  it("lässt eine fehlende Datei nicht wegfallen, wenn eine andere genannte da ist und eine Nummerndatei existiert", () => {
    expect(() => vorschau([buchung("5", { names: "a.pdf, fehlt.pdf" }), buchung("6", { names: "a.pdf" })], { "a.pdf": pdf("a"), "5.pdf": pdf("5") })).toThrow(
      "fehlt.pdf",
    );
  });

  it("behält beide Dateien im älteren Muster, wenn die Beleg-URL auf eine davon endet", () => {
    const result = vorschau([buchung("97", { url: "https://bb.example/belege/97_1.pdf" })], { "97_1.pdf": pdf("1"), "97_2.pdf": pdf("2") });
    expect(dateien(result)).toEqual([["97_1.pdf", "97_2.pdf"]]);
  });

  it("findet in einem Feld mit mehreren Dateien auch den Namen mit Komma", () => {
    const result = vorschau([buchung("1", { names: "Miete, Mai.pdf, b.pdf" })], { "Miete, Mai.pdf": pdf("m"), "b.pdf": pdf("b") });
    expect(dateien(result)).toEqual([["Miete, Mai.pdf", "b.pdf"]]);
  });

  it("trennt zwei Beleg-URLs auch bei Komma mit Leerzeichen", () => {
    const result = vorschau([buchung("1", { url: "https://bb.example/a.pdf, https://bb.example/b.pdf" }), buchung("2", { url: "https://bb.example/a.pdf" })], {
      "a.pdf": pdf("a"),
      "b.pdf": pdf("b"),
    });
    expect(dateien(result)).toEqual([["a.pdf", "b.pdf"], ["a.pdf"]]);
  });
});
