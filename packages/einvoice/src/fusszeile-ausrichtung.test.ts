import { DEFAULT_OPTIONS, dunningAmounts, type FooterAlign } from "@haben/core";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDunningPdf } from "./dunning.ts";
import { renderInvoicePdf } from "./pdf.ts";
import { sampleBuyer, sampleDocument, sampleSeller } from "./samples.ts";
import type { Letterhead } from "./types.ts";
import { templateInputs } from "./vorlage-eingaben.ts";

/** Leere Zeilen und Ausrichtung der Spalten im Fuß (#2046), an der Lage der Wörter im gesetzten PDF */
type Wort = { text: string; y: number };

function worte(pdf: Uint8Array): Wort[] | null {
  const dir = mkdtempSync(join(tmpdir(), "haben-fuss-ausrichtung-"));
  try {
    writeFileSync(join(dir, "beleg.pdf"), pdf);
    const xml = execFileSync("pdftotext", ["-bbox", "-l", "1", join(dir, "beleg.pdf"), "-"], { encoding: "utf8" });
    return [...xml.matchAll(/<word xMin="[\d.]+" yMin="([\d.]+)" xMax="[\d.]+" yMax="[\d.]+">([^<]*)</g)].map((m) => ({ y: Number(m[1]), text: m[2]! }));
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hatPdftotext = worte(renderInvoicePdf(sampleDocument())) !== null;

// Vier, zwei, eine und drei Zeilen; leere Zeilen am Anfang und in der Mitte
const SPALTEN = ["{firma}\n{strasse}\n{plz} {ort}\nLETZTEZEILE", "\nBANKMARKE", "STEUERMARKE {steuernummer}", "MITTEOBEN\n\nMITTEUNTEN"];

const optionen = (footerAlign: FooterAlign) => ({ ...DEFAULT_OPTIONS, footerColumns: SPALTEN, footerCustom: true, footerAlign });

const VORLAGEN: { name: string; layout?: Letterhead["layout"] }[] = [
  { name: "Klar Klassisch (rechnung.typ, mahnung.typ)" },
  { name: "Klar Standard (layout-basis.typ)", layout: { id: "klar", optionen: { fassung: "standard" } } },
  { name: "Modern", layout: { id: "modern" } },
];

const rechnung = (layout: Letterhead["layout"], align: FooterAlign) =>
  renderInvoicePdf({ ...sampleDocument(), ...(layout ? { layout } : {}), options: optionen(align) });

const mahnung = (layout: Letterhead["layout"], align: FooterAlign) =>
  buildDunningPdf({
    level: 2,
    date: "2026-10-16",
    dueDate: "2026-10-26",
    seller: sampleSeller,
    buyer: sampleBuyer,
    invoice: { number: "2026-034", issueDate: "2026-09-02", dueDate: "2026-09-16" },
    amounts: dunningAmounts({ open: 1_740_958, dueDate: "2026-09-16", date: "2026-10-16", fee: 5_000, flatFee: true, interestRate: 1_027 }),
    intro: "leider haben wir keinen Zahlungseingang erhalten.",
    closing: "Sollten Sie bereits gezahlt haben, ist dieses Schreiben gegenstandslos.",
    ...(layout ? { layout } : {}),
    options: optionen(align),
  });

/** Höhe der Oberkante eines Worts; die erste Fundstelle von unten, also im Fuß */
function hoehe(alle: Wort[], text: string): number {
  const treffer = alle.filter((wort) => wort.text === text);
  expect(treffer.length, `„${text}“ nicht im PDF`).toBeGreaterThan(0);
  return Math.max(...treffer.map((wort) => wort.y));
}

describe.skipIf(!hatPdftotext)("Fußzeile: leere Zeilen und Ausrichtung der Spalten (#2046)", () => {
  describe.each([
    ["Rechnung", rechnung],
    ["Mahnung", mahnung],
  ] as const)("%s", (_art, setzen) => {
    it.each(VORLAGEN)("$name: oben bündig, leere Zeilen am Anfang und in der Mitte bleiben stehen", ({ layout }) => {
      const alle = worte(setzen(layout, "oben"))!;
      const zeile = hoehe(alle, "Lindenstraße") - hoehe(alle, "Erika");
      expect(zeile).toBeGreaterThan(0);
      expect(hoehe(alle, "STEUERMARKE")).toBeCloseTo(hoehe(alle, "Erika"), 0);
      expect(hoehe(alle, "MITTEOBEN")).toBeCloseTo(hoehe(alle, "Erika"), 0);
      // Die leere erste Zeile schiebt BANKMARKE in die zweite, die leere mittlere MITTEUNTEN in die dritte
      expect(hoehe(alle, "BANKMARKE")).toBeCloseTo(hoehe(alle, "Lindenstraße"), 0);
      expect(hoehe(alle, "MITTEUNTEN")).toBeCloseTo(hoehe(alle, "10969"), 0);
    });

    it.each(VORLAGEN)("$name: unten bündig auf der letzten Zeile, der Fuß bleibt gleich hoch", ({ layout }) => {
      const oben = worte(setzen(layout, "oben"))!;
      const unten = worte(setzen(layout, "unten"))!;
      const letzte = hoehe(unten, "LETZTEZEILE");
      expect(hoehe(unten, "BANKMARKE")).toBeCloseTo(letzte, 0);
      expect(hoehe(unten, "STEUERMARKE")).toBeCloseTo(letzte, 0);
      expect(hoehe(unten, "MITTEUNTEN")).toBeCloseTo(letzte, 0);
      // Die längste Spalte steht wie oben bündig: Rand und Höhe des Fußes ändern sich nicht
      expect(hoehe(unten, "Erika")).toBeCloseTo(hoehe(oben, "Erika"), 1);
      expect(hoehe(unten, "MITTEOBEN")).toBeCloseTo(hoehe(unten, "Lindenstraße"), 0);
    });
  });

  it("die automatische Fußzeile steht unten bündig ebenso", () => {
    const automatisch = (footerAlign: FooterAlign) => worte(renderInvoicePdf({ ...sampleDocument(), options: { ...DEFAULT_OPTIONS, footerAlign } }))!;
    // Kontakt hat mehr Zeilen als die Steuernummern: unten bündig rückt deren erste Zeile nach unten
    expect(hoehe(automatisch("unten"), "Steuernummer")).toBeGreaterThan(hoehe(automatisch("oben"), "Steuernummer") + 1);
  });

  it.each([
    ["Elegant", { id: "elegant", optionen: { fuss: "rechts" } }],
    ["Atelier", { id: "atelier", optionen: { fuss: "rechts" } }],
  ] as const)("%s mit Fuß in der Randspalte setzt die leeren Zeilen mit", (_name, layout) => {
    const alle = worte(rechnung(layout, "unten"))!;
    expect(hoehe(alle, "MITTEUNTEN") - hoehe(alle, "MITTEOBEN")).toBeGreaterThan(1.5 * (hoehe(alle, "Lindenstraße") - hoehe(alle, "Erika")));
  });
});

describe("Ausrichtung im Feldvertrag (#2046)", () => {
  const look = (letterhead: Letterhead) => (templateInputs({}, letterhead) as { look: { footerAlign: FooterAlign } }).look;

  it("gibt die Wahl an eingebaute und eigene Layouts weiter, ab Werk oben", () => {
    expect(look({}).footerAlign).toBe("oben");
    expect(look({ options: { ...DEFAULT_OPTIONS, footerAlign: "unten" } }).footerAlign).toBe("unten");
    expect(look({ layout: { id: "modern" }, options: { ...DEFAULT_OPTIONS, footerAlign: "unten" } }).footerAlign).toBe("unten");
  });

  it("eine ältere Gestaltung ohne die Wahl steht oben", () => {
    const { footerAlign: _footerAlign, ...aelter } = DEFAULT_OPTIONS;
    expect(look({ options: aelter as typeof DEFAULT_OPTIONS }).footerAlign).toBe("oben");
  });
});
