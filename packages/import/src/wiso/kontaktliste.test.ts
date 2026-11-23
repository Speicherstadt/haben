import { describe, expect, it } from "vitest";
import { readWisoContactList } from "./kontaktliste.ts";

const page = (rows: string[], number = 1) =>
  [
    `Unternehmen / Firma Beispielbüro                                                     Seite ${number}`,
    "",
    "Kunden / Interessenten",
    "Name, Anschrift             Telefon          Kontaktdaten      Bankverbindung      Umsatz                    Notizen",
    ...rows,
    "                                                                                  Soweit im Einzelnen nicht anders vermerkt, Betragsangaben in Euro.",
  ].join("\n");

const kontakt = (number: string, name: string, postalLine = "12345 Musterstadt") => [
  `${number}, ${name.padEnd(22)}  k.A.             k.A.              k.A.                 Umsatz (netto): 0,00 €      k.A.`,
  "Beispielweg 1                                                                      Kreditlimit: 0,00 €",
  postalLine,
  "2. Anschrift",
  "k.A.",
];

describe("WISO-Kunden-/Interessentenliste", () => {
  it("liest Kontaktnummern und vollständige Namen über Seiten hinweg", () => {
    const [row, ...rest] = kontakt("0001", "Muster Beispiel");
    const result = readWisoContactList([page([row!, "mit langem Namen GmbH", ...rest]), page(kontakt("0002", "Andere Firma", "L - 1821 Luxembourg"), 2)]);
    expect(result.contacts).toEqual([
      {
        number: "0001",
        name: "Muster Beispiel mit langem Namen GmbH",
        street: "Beispielweg 1",
        postalCode: "12345",
        city: "Musterstadt",
        country: "DE",
        page: 1,
      },
      { number: "0002", name: "Andere Firma", street: "Beispielweg 1", postalCode: "L - 1821", city: "Luxembourg", country: null, page: 2 },
    ]);
    expect(result.warnings).toEqual([expect.stringMatching(/Seite 1.*0001.*Namensumbruch/), expect.stringMatching(/Seite 2.*0002.*Land prüfen/)]);
  });

  it("warnt bei Zusatzangaben außerhalb der CSV-Felder", () => {
    const rows = kontakt("0003", "Dritte Firma");
    rows.splice(3, 0, "Ansprechpartner: Frau Probe");
    rows[0] = rows[0]!.replace("k.A.", "1234");
    rows[rows.length - 1] = "Musterstraße 4";
    expect(readWisoContactList([page(rows)]).warnings).toEqual([expect.stringMatching(/Seite 1.*0003.*Zusatzangaben/)]);
  });

  it("weist unbekannte Seiten und unvollständige Kontaktzeilen zurück", () => {
    expect(() => readWisoContactList([page(kontakt("0001", "Beispiel")), ""])).toThrow(/Seite 2/);
    expect(() => readWisoContactList([page(kontakt("0001", "Beispiel", "???"))])).toThrow(/Seite 1.*0001.*Anschrift/);
    expect(() => readWisoContactList([page([...kontakt("0001", "Beispiel"), ...kontakt("0001", "Doppelt")])])).toThrow(/0001.*mehrfach/);
  });

  it("verliert bei breiteren Wortabständen weder Namensteile noch weitere Kontakte", () => {
    const rows = [...kontakt("0001", "Muster  GmbH"), ...kontakt("0002", " Zweite Firma")];
    const { contacts } = readWisoContactList([page(rows)]);
    expect(contacts.map(({ number, name }) => [number, name])).toEqual([
      ["0001", "Muster GmbH"],
      ["0002", "Zweite Firma"],
    ]);
  });

  it("weist abgeschnittene Kontakte und ausgelassene Seiten zurück", () => {
    expect(() => readWisoContactList([page([...kontakt("0001", "Beispiel"), "0002,"])])).toThrow(/Seite 1.*0002.*Name/);
    expect(() => readWisoContactList([page(kontakt("0001", "Beispiel")).replace("Seite 1", "Seite 2")])).toThrow(/Seite 1.*Seitennummer/);
  });
});
