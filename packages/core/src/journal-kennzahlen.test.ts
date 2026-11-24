import { describe, expect, it } from "vitest";
import type { InvoiceTotals } from "./invoice.ts";
import { bemessungAnZahlungen, JOURNAL_KENNZAHLEN, kennzahlenAusJournal, kennzahlenDerZeile, type JournalKennzahlen } from "./journal-kennzahlen.ts";
import { kategoriePosting } from "./direkt-kategorie.ts";
import {
  ACCOUNTS,
  documentPosting,
  exchangeDifferencePosting,
  invoiceCashPaymentPosting,
  invoicePaymentPosting,
  invoicePosting,
  invoiceWriteOffPosting,
  settlementTaxShares,
  type Kontenrahmen,
  type PostingLine,
  type Versteuerung,
  vorsteuerAusgleichPosting,
} from "./posting.ts";

/*
 * Kennzahlen aus dem Journal (#542, Schritt 2): Die Buchungen kommen aus denselben Funktionen, mit denen Haben bucht
 * (posting.ts), damit die Zuordnung an echten Buchungssätzen geprüft wird, je Steuerschlüssel und für SKR03 und SKR04.
 */

const KONTENRAHMEN: Kontenrahmen[] = ["SKR03", "SKR04"];

function totals(...taxes: { rate: 1900 | 700 | 0; base: number }[]): InvoiceTotals {
  const rows = taxes.map(({ rate, base }) => ({ rate, base, tax: Math.round((base * rate) / 10_000) }));
  const net = rows.reduce((s, r) => s + r.base, 0);
  const tax = rows.reduce((s, r) => s + r.tax, 0);
  return { net, tax, gross: net + tax, taxes: rows };
}

/** Nur die Kennzahlen, die nicht null sind */
function ohneNull(k: JournalKennzahlen): Partial<JournalKennzahlen> {
  return Object.fromEntries(Object.entries(k).filter(([, v]) => v !== 0));
}

/** Kennzahlen einer oder mehrerer Buchungen; ohne Angabe Soll-Versteuerung */
const kennzahlen = (kr: Kontenrahmen, lines: PostingLine[], versteuerung: Versteuerung = "soll", ...weitere: PostingLine[][]) =>
  ohneNull(kennzahlenAusJournal(kr, versteuerung, [lines, ...weitere]));

describe.each(KONTENRAHMEN)("Kennzahlen aus dem Journal (%s)", (kr) => {
  it("Soll: Rechnung mit 19 % und 7 % ergibt Kz 81, 86 und die Steuer", () => {
    const lines = invoicePosting(totals({ rate: 1900, base: 100_000 }, { rate: 700, base: 50_000 }), kr, "soll");
    expect(kennzahlen(kr, lines)).toEqual({ kz81: 100_000, tax81: 19_000, kz86: 50_000, tax86: 3_500 });
  });

  it("Soll: Stornorechnung (negativ) mindert Kz 81 und die Steuer", () => {
    const lines = invoicePosting(totals({ rate: 1900, base: -100_000 }), kr, "soll");
    expect(kennzahlen(kr, lines)).toEqual({ kz81: -100_000, tax81: -19_000 });
  });

  it("Ist: Rechnung auf Ziel zählt noch nicht, erst die Zahlung", () => {
    const t = totals({ rate: 1900, base: 100_000 });
    expect(kennzahlen(kr, invoicePosting(t, kr, "ist"), "ist")).toEqual({});
    expect(kennzahlen(kr, invoicePaymentPosting(t, t.gross, kr, "ist"), "ist")).toEqual({ kz81: 100_000, tax81: 19_000 });
  });

  // #542 Schritt 4: Bei Ist trägt die Zahlungsbuchung die Bemessungsgrundlage des bezahlten Anteils, wie bei DATEV der
  // Steuerschlüssel am Zahlungseingang (DATEV-Dok. 1080673)
  it("Ist: Zahlung meldet Bemessungsgrundlage und Steuer je Satz, auch als Teilzahlung", () => {
    const t = totals({ rate: 1900, base: 100_000 }, { rate: 700, base: 50_000 });
    expect(kennzahlen(kr, invoicePaymentPosting(t, t.gross, kr, "ist"), "ist")).toEqual({ kz81: 100_000, tax81: 19_000, kz86: 50_000, tax86: 3_500 });
    const teil = invoicePaymentPosting(t, 50_000, kr, "ist");
    const k = kennzahlen(kr, teil, "ist");
    expect((k.kz81 ?? 0) + (k.tax81 ?? 0) + (k.kz86 ?? 0) + (k.tax86 ?? 0)).toBe(50_000);
  });

  it("Ist: Rücklastschrift (negative Zahlung) mindert Bemessungsgrundlage und Steuer", () => {
    const t = totals({ rate: 1900, base: 100_000 });
    expect(kennzahlen(kr, invoicePaymentPosting(t, -t.gross, kr, "ist"), "ist")).toEqual({ kz81: -100_000, tax81: -19_000 });
  });

  it("Ist: Bareinnahme auf eine Rechnung wie die Zahlung über die Bank", () => {
    const t = totals({ rate: 700, base: 10_000 });
    expect(kennzahlen(kr, invoiceCashPaymentPosting(t, t.gross, kr, "ist"), "ist")).toEqual({ kz86: 10_000, tax86: 700 });
  });

  it("Ist: Zahlung auf eine Rechnung mit 19 % und 0 % meldet auch den Anteil zu 0 %", () => {
    const t = totals({ rate: 1900, base: 100_000 }, { rate: 0, base: 20_000 });
    expect(kennzahlen(kr, invoicePaymentPosting(t, t.gross, kr, "ist"), "ist")).toEqual({ kz81: 100_000, tax81: 19_000, steuerfrei: 20_000 });
  });

  it.each([
    ["steuerfrei", "kz48"],
    ["ausfuhr", "kz43"],
  ] as const)("Ist: Zahlung auf eine Rechnung %s meldet %s", (treatment, feld) => {
    const t = totals({ rate: 0, base: 500_000 });
    expect(kennzahlen(kr, invoicePaymentPosting(t, t.gross, kr, "ist", undefined, treatment), "ist")).toEqual({ [feld]: 500_000 });
  });

  it.each(["reverse_charge", "drittland", "ig_lieferung", "kleinunternehmer"] as const)(
    "Ist: Zahlung auf eine Rechnung %s meldet nichts (zählt mit der Rechnung bzw. gar nicht)",
    (treatment) => {
      const t = totals({ rate: 0, base: 500_000 });
      expect(kennzahlen(kr, invoicePaymentPosting(t, t.gross, kr, "ist", undefined, treatment), "ist")).toEqual({});
    },
  );

  it("Ist: Kursdifferenz einer Ausfuhr in Fremdwährung meldet ihren Anteil an Kz 43", () => {
    const t = totals({ rate: 0, base: 100_000 });
    const lines = exchangeDifferencePosting({ kind: "invoice", totals: t, versteuerung: "ist", treatment: "ausfuhr" }, 1_234, kr);
    expect(kennzahlen(kr, lines, "ist")).toEqual({ kz43: 1_234 });
  });

  it("Soll: Zahlung meldet nichts, die Rechnung hat schon gemeldet", () => {
    const t = totals({ rate: 1900, base: 100_000 });
    expect(kennzahlen(kr, invoicePaymentPosting(t, t.gross, kr, "soll"))).toEqual({});
  });

  it("Ist: Skonto auf eine Rechnung zählt nicht, bei Soll mindert es Kz 81 und die Steuer", () => {
    const t = totals({ rate: 1900, base: 100_000 });
    expect(kennzahlen(kr, invoiceWriteOffPosting("skonto", t, 2_380, kr, "ist"), "ist")).toEqual({});
    expect(kennzahlen(kr, invoiceWriteOffPosting("skonto", t, 2_380, kr, "soll"))).toEqual({ kz81: -2_000, tax81: -380 });
  });

  // #1267: Anleitung zur UStVA 2026, Kz 50; § 17 Abs. 2 Nr. 1 Satz 1 UStG
  it("Soll: Forderungsausfall mindert Kz 81 und 86 und meldet die Minderung zusätzlich in Kz 50", () => {
    const t = totals({ rate: 1900, base: 100_000 }, { rate: 700, base: 50_000 });
    expect(kennzahlen(kr, invoiceWriteOffPosting("forderungsausfall", t, t.gross, kr, "soll"))).toEqual({
      kz81: -100_000,
      tax81: -19_000,
      kz86: -50_000,
      tax86: -3_500,
      kz50: 150_000,
    });
  });

  it("Soll: aufgehobener Forderungsausfall (Gegenbuchung) nimmt Kz 50 wieder zurück", () => {
    const t = totals({ rate: 1900, base: 100_000 });
    const ausfall = invoiceWriteOffPosting("forderungsausfall", t, t.gross, kr, "soll");
    const gegen = ausfall.map((z) => ({ ...z, debit: z.credit, credit: z.debit }));
    expect(kennzahlen(kr, ausfall, "soll", gegen)).toEqual({});
  });

  it("Ist: Forderungsausfall meldet nichts, auch kein Kz 50; Skonto gewährt nie Kz 50", () => {
    const t = totals({ rate: 1900, base: 100_000 });
    expect(kennzahlen(kr, invoiceWriteOffPosting("forderungsausfall", t, t.gross, kr, "ist"), "ist")).toEqual({});
    expect(kennzahlen(kr, invoiceWriteOffPosting("skonto", t, 2_380, kr, "soll"))).not.toHaveProperty("kz50");
  });

  it.each(["reverse_charge", "ig_lieferung", "drittland", "ausfuhr", "steuerfrei"] as const)(
    "Soll: Forderungsausfall einer Rechnung ohne Steuer (%s) meldet kein Kz 50",
    (treatment) => {
      const t = totals({ rate: 0, base: 100_000 });
      expect(kennzahlen(kr, invoiceWriteOffPosting("forderungsausfall", t, t.gross, kr, "soll", treatment))).not.toHaveProperty("kz50");
    },
  );

  it("Ist: Direkt auf eine Einnahmekategorie gebuchter Bankumsatz zählt sofort", () => {
    const lines = kategoriePosting({ kategorie: "erloese", steuersatz: 1900 }, 11_900, kr);
    expect(kennzahlen(kr, lines, "ist")).toEqual({ kz81: 10_000, tax81: 1_900 });
  });

  it.each(["reverse_charge", "drittland", "ig_lieferung"] as const)("Ist: %s zählt mit der Rechnung", (treatment) => {
    expect(Object.values(kennzahlen(kr, invoicePosting(totals({ rate: 0, base: 500_000 }), kr, "ist", treatment), "ist"))).toEqual([500_000]);
  });

  it.each(["ausfuhr", "steuerfrei"] as const)("Ist: %s zählt erst mit der Zahlung", (treatment) => {
    expect(kennzahlen(kr, invoicePosting(totals({ rate: 0, base: 500_000 }), kr, "ist", treatment), "ist")).toEqual({});
  });

  it.each([
    ["reverse_charge", "kz21"],
    ["drittland", "kz45"],
    ["steuerfrei", "kz48"],
    ["ig_lieferung", "kz41"],
    ["ausfuhr", "kz43"],
  ] as const)("Rechnung ohne Steuer (%s) ergibt %s", (treatment, feld) => {
    const lines = invoicePosting(totals({ rate: 0, base: 500_000 }), kr, "soll", treatment);
    expect(kennzahlen(kr, lines)).toEqual({ [feld]: 500_000 });
  });

  it("Kleinunternehmer-Rechnung erscheint in keiner Kennzahl, regulär zu 0 % nur unter „steuerfrei“", () => {
    expect(kennzahlen(kr, invoicePosting(totals({ rate: 0, base: 500_000 }), kr, "soll", "kleinunternehmer"))).toEqual({});
    expect(kennzahlen(kr, invoicePosting(totals({ rate: 0, base: 500_000 }), kr, "soll"))).toEqual({ steuerfrei: 500_000 });
  });

  it("Beleg mit Vorsteuer ergibt Kz 66, ohne Vorsteuerabzug nichts", () => {
    const t = totals({ rate: 1900, base: 10_000 }, { rate: 700, base: 2_000 });
    expect(kennzahlen(kr, documentPosting(t, "software", kr, "einzelunternehmen", "bank"))).toEqual({ kz66: 2_040 });
    expect(kennzahlen(kr, documentPosting(t, "software", kr, "einzelunternehmen", "bank", false))).toEqual({});
  });

  it("§ 13b aus dem EU-Ausland und dem Drittland ergibt Kz 46/47 bzw. 84/85 und die Vorsteuer Kz 67", () => {
    const t = { ...totals({ rate: 1900, base: 10_000 }), gross: 10_000 };
    const eu = documentPosting(t, "software", kr, "einzelunternehmen", "bank", true, undefined, 0, "eu");
    expect(kennzahlen(kr, eu)).toEqual({ kz46: 10_000, kz47: 1_900, kz67: 1_900 });
    const drittland = documentPosting(t, "software", kr, "einzelunternehmen", "bank", true, undefined, 0, "drittland");
    expect(kennzahlen(kr, drittland)).toEqual({ kz84: 10_000, kz85: 1_900, kz67: 1_900 });
  });

  // #542 Schritt 4: Das Journal trägt die volle Bemessungsgrundlage auch ohne Vorsteuerabzug und mit Privatanteil,
  // wie computeVatFigures (Kz 46/84/89/93 voll, nur Kz 67/61 betrieblich)
  it("§ 13b ohne Vorsteuerabzug (Kleinunternehmer): Kz 46 ist das Netto, die Steuer zählt nur in Kz 47", () => {
    const t = { ...totals({ rate: 1900, base: 10_000 }), gross: 10_000 };
    const lines = documentPosting(t, "software", kr, "einzelunternehmen", "bank", false, undefined, 0, "eu");
    expect(kennzahlen(kr, lines)).toEqual({ kz46: 10_000, kz47: 1_900 });
  });

  it("§ 13b mit Privatanteil: Kz 46 und 47 voll, nur Kz 67 betrieblich", () => {
    const t = { ...totals({ rate: 1900, base: 20_000 }), gross: 20_000 };
    const lines = documentPosting(t, "software", kr, "einzelunternehmen", "bank", true, undefined, 25, "eu");
    expect(kennzahlen(kr, lines)).toEqual({ kz46: 20_000, kz47: 3_800, kz67: 2_850 });
  });

  it("Innergemeinschaftlicher Erwerb mit Privatanteil: Kz 89 und Erwerbsteuer voll, nur Kz 61 betrieblich", () => {
    const t = { ...totals({ rate: 1900, base: 10_000 }), gross: 10_000 };
    const lines = documentPosting(t, "wareneinkauf", kr, "einzelunternehmen", "bank", true, undefined, 30, "ig_erwerb");
    expect(kennzahlen(kr, lines)).toEqual({ kz89: 10_000, tax89: 1_900, kz61: 1_330 });
  });

  it("Innergemeinschaftlicher Erwerb ergibt Kz 89/93 mit Erwerbsteuer und die Vorsteuer Kz 61", () => {
    const t = { ...totals({ rate: 1900, base: 10_000 }, { rate: 700, base: 5_000 }), gross: 15_000 };
    const lines = documentPosting(t, "wareneinkauf", kr, "einzelunternehmen", "bank", true, undefined, 0, "ig_erwerb");
    expect(kennzahlen(kr, lines)).toEqual({ kz89: 10_000, tax89: 1_900, kz93: 5_000, tax93: 350, kz61: 2_250 });
  });

  it("Einfuhrumsatzsteuer laut Bescheid ergibt Kz 62", () => {
    const lines = documentPosting(totals({ rate: 0, base: 1_900 }), "einfuhrumsatzsteuer", kr, "einzelunternehmen", "bank");
    expect(kennzahlen(kr, lines)).toEqual({ kz62: 1_900 });
  });

  it("Zeilen ohne Kennzahl: Forderungen, Bank, Aufwand mit Vorsteuer, „Umsatzsteuer nicht fällig“", () => {
    const a = ACCOUNTS[kr];
    for (const zeile of [
      { account: a.forderungen, debit: 11_900, credit: 0, taxCode: null },
      { account: a.bank, debit: 11_900, credit: 0, taxCode: null },
      { account: "4980", debit: 10_000, credit: 0, taxCode: "VSt19" },
      { account: a.ustNichtFaellig[1900], debit: 0, credit: 1_900, taxCode: "USt19" },
    ])
      expect(kennzahlenDerZeile(kr, zeile)).toEqual([]);
  });
});

it("jede Kennzahl hat ein Feld in der leeren Summe", () => {
  expect(Object.keys(kennzahlenAusJournal("SKR03", "soll", []))).toEqual([...JOURNAL_KENNZAHLEN]);
});

// TDD-Review #552: Ein Anteil mit Bemessungsgrundlage, aber nach Rundung 0,00 € Steuer, trägt seine Bemessungsgrundlage
// trotzdem ins Journal, wie computeVatFigures sie zählt
describe("Ist, Anteil mit Bemessungsgrundlage, aber ohne Steuer", () => {
  const t: InvoiceTotals = { net: 100_000, tax: 19_000, gross: 119_000, taxes: [{ rate: 1900, base: 100_000, tax: 19_000 }] };
  for (const kr of KONTENRAHMEN) {
    it(`${kr}: Kursdifferenz von 0,02 € meldet ihre Bemessungsgrundlage (paidTaxShares)`, () => {
      const lines = exchangeDifferencePosting({ kind: "invoice", totals: t, versteuerung: "ist" }, 2, kr);
      expect(kennzahlenAusJournal(kr, "ist", [lines]).kz81).toBe(2);
    });
    it(`${kr}: Restzahlung von 0,01 € (Anteil 1 ct ohne Steuer) meldet ihre Bemessungsgrundlage`, () => {
      const lines = invoicePaymentPosting(t, 1, kr, "ist", [{ rate: 1900, base: 1, tax: 0 }]);
      expect(kennzahlenAusJournal(kr, "ist", [lines]).kz81).toBe(1);
    });
    it(`${kr}: Rücklastschrift desselben Anteils mindert sie wieder`, () => {
      const lines = invoicePaymentPosting(t, -1, kr, "ist", [{ rate: 1900, base: -1, tax: 0 }]);
      expect(kennzahlenAusJournal(kr, "ist", [lines]).kz81).toBe(-1);
    });
  }
});

// #1312: Bei Ist rechnet die Voranmeldung den Teil von Kz 43 und 48 heraus, den Zahlungen tragen
describe.each(KONTENRAHMEN)("Kz 43 und 48 an Zahlungen (%s)", (kr) => {
  const frei = totals({ rate: 0, base: 50_000 });
  it("Zahlung, Bareinnahme und Rücklastschrift auf steuerfreie und Ausfuhr-Rechnungen, nicht die Rechnung selbst", () => {
    const buchungen = [
      invoicePosting(frei, kr, "ist", "steuerfrei"),
      invoicePaymentPosting(frei, 50_000, kr, "ist", undefined, "steuerfrei"),
      invoiceCashPaymentPosting(frei, 20_000, kr, "ist", undefined, "ausfuhr"),
      invoicePaymentPosting(frei, -5_000, kr, "ist", undefined, "ausfuhr"),
    ];
    expect(bemessungAnZahlungen(kr, buchungen)).toEqual({ kz43: 15_000, kz48: 50_000 });
    expect(kennzahlenAusJournal(kr, "ist", buchungen)).toMatchObject({ kz43: 15_000, kz48: 50_000 });
  });
  it("Kz 81 an der Zahlung zählt nicht mit", () => {
    const t = totals({ rate: 1900, base: 10_000 });
    expect(bemessungAnZahlungen(kr, [invoicePaymentPosting(t, t.gross, kr, "ist")])).toEqual({ kz43: 0, kz48: 0 });
  });
});

/*
 * Zwischenkonto einer Gutschrift „erstattet bereits Bezahltes“ (#786, Etappe 4): Solange die Vorsteuer geparkt ist, steht
 * sie auf SKR03 1548 / SKR04 1434 und in keiner Kennzahl — auch nicht in Kz 66, obwohl die Zeile einen Steuerschlüssel
 * trägt. Erst die Umbuchung beim Ausgleich legt sie auf 1576/1406, und dort trägt sie die Kennzahl. Der Test vergleicht
 * beide Zustände, damit ein Konto ohne Kennzahl nicht stillschweigend die Minderung verschluckt.
 */
describe.each(KONTENRAHMEN)("Zwischenkonto der Gutschrift „erstattet bereits Bezahltes“ (%s)", (kr) => {
  const a = ACCOUNTS[kr];
  /** Gutschrift über 100,00 € netto, 19 %, mit der Angabe „erstattet bereits Bezahltes“ */
  const gutschrift: InvoiceTotals = { net: -10_000, tax: -1_900, gross: -11_900, taxes: [{ rate: 1900, base: -10_000, tax: -1_900 }] };
  const buchen = () => documentPosting(gutschrift, "software", kr, "einzelunternehmen", "bank", true, undefined, 0, null, true);
  const umbuchen = (betrag = 11_900) => vorsteuerAusgleichPosting(settlementTaxShares(gutschrift, 0, [], betrag), kr);

  for (const versteuerung of ["ist", "soll"] as const) {
    it(`${versteuerung}: geparkt keine Kennzahl, nach der Umbuchung Kz 66`, () => {
      // Geparkt: die Steuerzeile trägt den Steuerschlüssel, gehört aber in keine Kennzahl
      expect(kennzahlenDerZeile(kr, { account: a.vorsteuerNochNichtAbziehbar, debit: 0, credit: 1_900, taxCode: "VSt19" })).toEqual([]);
      expect(kennzahlenDerZeile(kr, { account: a.vorsteuerNochNichtAbziehbar, debit: 1_900, credit: 0, taxCode: "VSt19" })).toEqual([]);
      expect(kennzahlen(kr, buchen(), versteuerung)).toEqual({});
      expect(kennzahlen(kr, buchen(), versteuerung).kz66 ?? 0).toBe(0);

      // Ausgeglichen: die Umbuchung auf die Vorsteuer trägt Kz 66, die Bemessungsgrundlage steht im Journal
      expect(kennzahlen(kr, umbuchen(), versteuerung)).toEqual({ kz66: -1_900 });
      expect(kennzahlen(kr, buchen(), versteuerung, umbuchen())).toEqual({ kz66: -1_900 });
    });
  }

  it("eine Teilerstattung mindert Kz 66 nur um ihren Anteil", () => {
    expect(kennzahlen(kr, umbuchen(5_950)).kz66).toBe(-950);
  });

  it("7 % geht genauso über das Zwischenkonto und trägt nach der Umbuchung Kz 66", () => {
    const sieben: InvoiceTotals = { net: -10_000, tax: -700, gross: -10_700, taxes: [{ rate: 700, base: -10_000, tax: -700 }] };
    const buchen7 = () => documentPosting(sieben, "software", kr, "einzelunternehmen", "bank", true, undefined, 0, null, true);
    expect(kennzahlen(kr, buchen7())).toEqual({});
    const umbuchen7 = vorsteuerAusgleichPosting(settlementTaxShares(sieben, 0, [], 10_700), kr);
    expect(kennzahlen(kr, buchen7(), "soll", umbuchen7)).toEqual({ kz66: -700 });
  });

  it("ohne die Angabe mindert die Buchung Kz 66 sofort — der Unterschied ist genau die Parkbuchung", () => {
    const ohne = documentPosting(gutschrift, "software", kr, "einzelunternehmen", "bank", true, undefined, 0, null, false);
    expect(kennzahlen(kr, ohne)).toEqual({ kz66: -1_900 });
  });
});
