import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isDatevStammdaten, parseDatevStammdaten } from "./datev-stammdaten.ts";

const fixture = (version: string) =>
  new Uint8Array(readFileSync(new URL(`../test-fixtures/sevdesk/buchhaltung-${version}/extf-gp-stamm.csv`, import.meta.url)));

// Kopf und Spalten wie im Export von sevDesk (254 Spalten, EXTF Kategorie 16 Version 5); die Zeilen sind erfunden
const fixtureText = new TextDecoder("utf-8").decode(fixture("2.0"));
const COLUMNS = fixtureText.split(/\r?\n/)[1]!.split(";");
const HEADER = `"EXTF";700;16;"Debitoren/Kreditoren";5;;;;;;1;1;20240101;4;;;;;;;;;;;;;;;;;`;

/** Eine Datenzeile mit Werten nach Spaltenname */
const row = (values: Record<string, string>) =>
  COLUMNS.map((name) => {
    if (!(name in values)) return "";
    return values[name]!;
  }).join(";");
const utf8 = (...lines: string[]) => new TextEncoder().encode([HEADER, COLUMNS.join(";"), ...lines].join("\r\n"));
const parsed = (bytes: Uint8Array) => {
  const result = parseDatevStammdaten(bytes);
  if (!result.ok) throw new Error(result.error);
  return result;
};

describe("isDatevStammdaten", () => {
  it("erkennt den GP-Stamm beider Buchhaltungsversionen, nicht den Buchungsstapel oder eine CSV-Liste", () => {
    expect(isDatevStammdaten(fixture("1.0"))).toBe(true);
    expect(isDatevStammdaten(fixture("2.0"))).toBe(true);
    expect(isDatevStammdaten(new Uint8Array(readFileSync(new URL("../test-fixtures/sevdesk/buchhaltung-2.0/extf-buchungsstapel.csv", import.meta.url))))).toBe(
      false,
    );
    expect(isDatevStammdaten(new TextEncoder().encode("Kundennummer;Firmenname\n1;A"))).toBe(false);
  });
});

describe("parseDatevStammdaten", () => {
  it("liest den GP-Stamm aus Buchhaltung 2.0 (UTF-8): zwei Kreditoren", () => {
    const { encoding, rows } = parsed(fixture("2.0"));
    expect(encoding).toBe("utf-8");
    expect(rows.map((r) => [r.line, r.nr, r.rolle, r.name, r.errors])).toEqual([
      [3, 70005, "kreditor", "<anon>", []],
      [4, 70006, "kreditor", "<anon>", []],
    ]);
  });

  it("lehnt einen GP-Stamm mit Sachkontenlänge 1 ab, statt Nummern zu kürzen", () => {
    // Nur im Speicher geändert; latin1 bildet jedes Byte auf ein Zeichen ab und zurück
    const text = Buffer.from(fixture("1.0")).toString("latin1").replace(";11111111;4;", ";11111111;1;");
    expect(parseDatevStammdaten(new Uint8Array(Buffer.from(text, "latin1")))).toEqual({
      ok: false,
      error:
        "Die Kopfzeile nennt Sachkontenlänge 1. Haben führt Personenkonten fünfstellig (Sachkontenlänge 4) und kürzt keine Nummern; exportiere die Datei mit Sachkontenlänge 4.",
    });
  });

  it("liest den GP-Stamm aus Buchhaltung 1.0 (Windows-1252) mit Sachkontenlänge 4: Debitoren, USt-IdNr. aus Mitgliedstaat und Nummer", () => {
    const { encoding, rows } = parsed(fixture("1.0"));
    expect(encoding).toBe("windows-1252");
    expect(rows.map((r) => [r.line, r.nr, r.rolle, r.name, r.land])).toEqual([
      [3, 10001, "debitor", "<anon>", "DE"],
      [4, 10002, "debitor", "<anon>", "DE"],
    ]);
    // Die anonymisierte USt-IdNr. „DE<anon>“ hat nicht die Form einer USt-IdNr.
    expect(rows[0]!.errors).toEqual(["USt-IdNr.: „DE<anon>“ hat nicht die Form DE123456789"]);
  });

  it("übernimmt die Felder eines Unternehmens, einer Person und die Rolle aus dem Kontenbereich", () => {
    const { rows } = parsed(
      utf8(
        row({
          Konto: "10010",
          "Name (Adressatentyp Unternehmen)": "Müller & Söhne GmbH",
          Adressatentyp: "2",
          "EU-Mitgliedstaat": "DE",
          "EU-UStId.": "136695976",
          Straße: "Hauptstraße 5",
          Postleitzahl: "50667",
          Ort: "Köln",
          Land: "DE",
          Telefon: "+49 221 123456",
          "E-Mail": "rechnung@mueller.example",
          "IBAN-Nr. 1": "DE89 3704 0044 0532 0130 00",
          Kundennummer: "K-10",
          Steuernummer: "214/5678/9012",
        }),
        row({
          Konto: "70010",
          "Name (Adressatentyp natürl. Person)": "Mustermann",
          "Vorname (Adressatentyp natürl. Person)": "Erika",
          Adressatentyp: "1",
          Land: "AT",
        }),
      ),
    );
    expect(rows).toEqual([
      {
        line: 3,
        konto: "10010",
        rolle: "debitor",
        nr: 10010,
        name: "Müller & Söhne GmbH",
        strasse: "Hauptstraße 5",
        plz: "50667",
        ort: "Köln",
        land: "DE",
        landAngenommen: false,
        email: "rechnung@mueller.example",
        telefon: "+49 221 123456",
        ustId: "DE136695976",
        iban: "DE89370400440532013000",
        kundennummer: "K-10",
        steuernummer: "214/5678/9012",
        errors: [],
      },
      expect.objectContaining({ line: 4, rolle: "kreditor", nr: 70010, name: "Erika Mustermann", land: "AT", ustId: "", errors: [] }),
    ]);
  });

  it("nimmt eine USt-IdNr., die das Länderkennzeichen schon trägt, nicht doppelt", () => {
    const { rows } = parsed(
      utf8(row({ Konto: "10011", "Name (Adressatentyp keine Angabe)": "Agence SARL", "EU-Mitgliedstaat": "FR", "EU-UStId.": "FR12345678901" })),
    );
    expect(rows[0]).toMatchObject({ name: "Agence SARL", ustId: "FR12345678901", errors: [] });
  });

  it("macht ein Konto außerhalb der Personenkontenbereiche zur Fehlerzeile", () => {
    const { rows } = parsed(
      utf8(
        row({ Konto: "8400", "Name (Adressatentyp Unternehmen)": "Sachkonto" }),
        row({ Konto: "100001", "Name (Adressatentyp Unternehmen)": "Sechsstellig" }),
        row({ Konto: "D-1", "Name (Adressatentyp Unternehmen)": "Buchstaben" }),
        row({ Konto: "", "Name (Adressatentyp Unternehmen)": "Ohne Konto" }),
      ),
    );
    const error = (konto: string) => `Konto: „${konto}“ ist kein Personenkonto (Debitor 10000 bis 69999, Kreditor 70000 bis 99999)`;
    expect(rows.map((r) => [r.rolle, r.nr, r.errors])).toEqual([
      [null, null, [error("8400")]],
      [null, null, [error("100001")]],
      [null, null, [error("D-1")]],
      [null, null, ["Konto fehlt"]],
    ]);
  });

  it("lehnt eine andere Sachkontenlänge als 4 ab, statt Nummern zu kürzen", () => {
    const bytes = new TextEncoder().encode(
      [HEADER.replace(";20240101;4;", ";20240101;5;"), COLUMNS.join(";"), row({ Konto: "100010", "Name (Adressatentyp Unternehmen)": "A" })].join("\r\n"),
    );
    expect(parseDatevStammdaten(bytes)).toMatchObject({ ok: false, error: expect.stringContaining("Sachkontenlänge 5") });
  });

  it("nimmt eine leere Sachkontenlänge hin; die Bereiche prüft jede Zeile", () => {
    const bytes = new TextEncoder().encode(
      [HEADER.replace(";20240101;4;", ";20240101;;"), COLUMNS.join(";"), row({ Konto: "10012", "Name (Adressatentyp Unternehmen)": "A" })].join("\r\n"),
    );
    expect(parsed(bytes).rows.map((r) => r.nr)).toEqual([10012]);
  });

  it("meldet Fehler je Feld: Name, Land, IBAN, Telefon und Formeln", () => {
    const { rows } = parsed(
      utf8(
        row({ Konto: "10013" }),
        row({ Konto: "10014", "Name (Adressatentyp Unternehmen)": "=HYPERLINK(1)", Land: "Atlantis", "IBAN-Nr. 1": "DE00 1234", Telefon: "abc" }),
      ),
    );
    expect(rows[0]!.errors).toEqual(["Name fehlt"]);
    expect(rows[1]!.errors).toEqual([
      "Name: beginnt mit „=“ und sähe in Excel wie eine Formel aus; Zeichen am Anfang entfernen",
      "Land: „Atlantis“; bitte als Ländercode wie DE",
      "IBAN: „DE00 1234“ ist ungültig (Prüfziffer oder Länge)",
      expect.stringContaining("Telefon"),
    ]);
  });

  // Echter GP-Stamm aus sevDesk (#472, Kommentar in #811): Telefonnummern stehen dort mit vorangestelltem Apostroph,
  // damit Excel sie als Text liest; 5 von 168 Zeilen fielen sonst ganz aus dem Import. Nummern erfunden
  it("liest eine Telefonnummer mit vorangestelltem Apostroph ohne ihn", () => {
    const { rows } = parsed(
      utf8(
        row({ Konto: "10015", "Name (Adressatentyp Unternehmen)": "Erfundene Werkstatt", Telefon: "'+49(0)30/1234567" }),
        row({ Konto: "70015", "Name (Adressatentyp Unternehmen)": "Erfundener Verlag", Telefon: "'0301234567-89" }),
      ),
    );
    expect(rows.map((r) => [r.errors, r.telefon])).toEqual([
      [[], "+49(0)30/1234567"],
      [[], "0301234567-89"],
    ]);
  });

  it("meldet eine Telefonnummer, die nach dem Apostroph keine ist", () => {
    const { rows } = parsed(utf8(row({ Konto: "10016", "Name (Adressatentyp Unternehmen)": "Erfundene Werkstatt", Telefon: "'abc" })));
    expect(rows[0]!.errors).toEqual(["Telefon: nur Ziffern, Leerzeichen und + ( ) / - ."]);
  });

  // Echter GP-Stamm aus sevDesk (#472): „UN“ steht nur bei Kontakten ohne Anschrift; sevDesk zeigt dort „UNKNOWN“
  // (6 von 168 Zeilen, Kontakte aus einem früheren CSV-Import). Kein Land nach ISO 3166-1, also wie leer
  it("liest das Land „UN“ wie ein leeres Land", () => {
    const { rows } = parsed(
      utf8(
        row({ Konto: "70017", "Name (Adressatentyp Unternehmen)": "Erfundener Verlag", Land: "UN" }),
        row({ Konto: "70018", "Name (Adressatentyp Unternehmen)": "Erfundene Druckerei", Land: "" }),
      ),
    );
    expect(rows.map((r) => [r.errors, r.land])).toEqual([
      [[], "DE"],
      [[], "DE"],
    ]);
  });

  it("merkt sich, wenn das Land leer oder „UN“ ist und DE nur angenommen wird", () => {
    const { rows } = parsed(
      utf8(
        row({ Konto: "70017", "Name (Adressatentyp Unternehmen)": "Erfundener Verlag", Land: "UN" }),
        row({ Konto: "70018", "Name (Adressatentyp Unternehmen)": "Erfundene Druckerei", Land: "" }),
        row({ Konto: "70019", "Name (Adressatentyp Unternehmen)": "Erfundene Werkstatt", Land: "DE" }),
      ),
    );
    expect(rows.map((r) => [r.land, r.landAngenommen])).toEqual([
      ["DE", true],
      ["DE", true],
      ["DE", false],
    ]);
  });

  it("lehnt andere DATEV-Exporte und Dateien ohne Spalte Konto ab", () => {
    expect(parseDatevStammdaten(fixture("2.0").subarray(0, 0))).toEqual({ ok: false, error: "Die Datei ist leer." });
    const stapel = new TextEncoder().encode(`"EXTF";700;21;"Buchungsstapel";13\nUmsatz;Konto`);
    expect(parseDatevStammdaten(stapel)).toEqual({ ok: false, error: "Das ist ein DATEV-Export „Buchungsstapel“, keine Debitoren/Kreditoren." });
    expect(parseDatevStammdaten(new TextEncoder().encode(`${HEADER}\nName;Ort`))).toEqual({ ok: false, error: "Zeile 2: Spalte „Konto“ fehlt." });
  });

  it("liest UTF-8 mit BOM und überspringt leere Zeilen", () => {
    const bytes = utf8(row({ Konto: "10015", "Name (Adressatentyp Unternehmen)": "Bäckerei Süß" }), "", row({}));
    const { encoding, rows } = parsed(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]));
    expect(encoding).toBe("utf-8-bom");
    expect(rows.map((r) => r.name)).toEqual(["Bäckerei Süß"]);
  });
});

// Stamm aus BuchhaltungsButler (#1829): dieselben Spalten wie oben, drei Köpfe anders geschrieben; Werte erfunden
describe("parseDatevStammdaten: Köpfe von BuchhaltungsButler", () => {
  const bbName = (name: string) => name.replace("Adressatentyp", "Adressattyp").replace("EU-Mitgliedstaat", "EU-Land").replace("EU-UStId.", "EU-UStID");
  const bbColumns = COLUMNS.map(bbName);
  const bbRow = (values: Record<string, string>) => {
    // Jede Angabe muss eine Spalte treffen, sonst prüfte der Test nichts
    for (const name of Object.keys(values)) expect(bbColumns).toContain(name);
    return bbColumns.map((name) => values[name] ?? "").join(";");
  };
  const bb = (...lines: string[]) => parsed(new TextEncoder().encode([HEADER, bbColumns.join(";"), ...lines].join("\r\n"))).rows;

  it("schreibt die drei Köpfe anders als sevDesk", () => {
    expect(bbColumns).toEqual(expect.arrayContaining(["Name (Adressattyp Unternehmen)", "Name (Adressattyp keine Angabe)", "EU-Land", "EU-UStID"]));
    expect(bbColumns.join(";")).not.toMatch(/Adressatentyp|EU-Mitgliedstaat|EU-UStId\./);
  });

  it("liest Konto, Namen von Unternehmen, Person und „keine Angabe“ und die USt-IdNr.", () => {
    const rows = bb(
      bbRow({ Konto: "10000", "Name (Adressattyp Unternehmen)": "Beispiel GmbH", "EU-Land": "DE", "EU-UStID": "136695976" }),
      bbRow({ Konto: "69999", "Vorname (Adressattyp natürl. Person)": "Erika", "Name (Adressattyp natürl. Person)": "Muster" }),
      bbRow({ Konto: "70000", "Name (Adressattyp keine Angabe)": "Ohne Angabe", "EU-Land": "AT", "EU-UStID": "ATU12345678" }),
      bbRow({ Konto: "99999", "Name (Adressattyp Unternehmen)": "Lieferant AG" }),
    );
    expect(rows.map((r) => [r.nr, r.rolle, r.name, r.ustId, r.errors])).toEqual([
      [10000, "debitor", "Beispiel GmbH", "DE136695976", []],
      [69999, "debitor", "Erika Muster", "", []],
      [70000, "kreditor", "Ohne Angabe", "ATU12345678", []],
      [99999, "kreditor", "Lieferant AG", "", []],
    ]);
  });

  it("übernimmt eine Zeile mit Zahl in „EU-Land“ ohne USt-IdNr. und ohne Fehler", () => {
    const [zeile] = bb(bbRow({ Konto: "70001", "Name (Adressattyp Unternehmen)": "Zahl KG", "EU-Land": "19", "EU-UStID": "199405147" }));
    expect([zeile!.name, zeile!.ustId, zeile!.errors]).toEqual(["Zahl KG", "", []]);
  });

  it("meldet eine falsche USt-IdNr. mit Länderkürzel weiter als Fehler", () => {
    const [zeile] = bb(bbRow({ Konto: "70002", "Name (Adressattyp Unternehmen)": "Falsch KG", "EU-Land": "DE", "EU-UStID": "12" }));
    expect(zeile!.errors).toEqual(["USt-IdNr.: „DE12“ hat eine falsche Prüfziffer"]);
  });
});

describe("parseDatevStammdaten: USt-IdNr., die ihr Länderkennzeichen selbst trägt (#1829)", () => {
  const lesen = (land: string, nummer: string) => {
    const [zeile] = parsed(
      utf8(row({ Konto: "70001", "Name (Adressatentyp Unternehmen)": "Kennzeichen KG", "EU-Mitgliedstaat": land, "EU-UStId.": nummer })),
    ).rows;
    return [zeile!.ustId, zeile!.errors];
  };

  it.each([
    ["19", "DE136695976", "DE136695976"],
    ["13", "ATU12345678", "ATU12345678"],
  ])("behält bei Zahl %s in „EU-Land“ die gültige Nummer %s", (land, nummer, erwartet) => {
    expect(lesen(land, nummer)).toEqual([erwartet, []]);
  });

  it.each([
    ["GR", "EL123456789", "EL123456789"],
    ["gr", "el 123 456 789", "EL123456789"],
    ["EL", "GR123456789", "EL123456789"],
    ["GB", "XI123456789", "XI123456789"],
  ])("setzt bei Land %s kein zweites Kennzeichen vor %s", (land, nummer, erwartet) => {
    expect(lesen(land, nummer)).toEqual([erwartet, []]);
  });
});
