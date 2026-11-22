import { DEFAULT_FOOTER_COLUMNS, DEFAULT_OPTIONS, type LetterheadOptions } from "@haben/core";
import { describe, expect, it } from "vitest";
import { kenntPflichtangabenFelder } from "./layout-gestaltung.ts";
import { footerData, templateInputs } from "./pdf.ts";
import { gmbhSeller, sampleSeller } from "./samples.ts";
import type { Letterhead } from "./types.ts";

/* Pflichtangaben der GmbH im Fuß (#1651): Platzhalter, Stelle und eigene Layouts, die die neuen Felder nicht kennen */

const MIT_ALLEN =
  "Sitz {sitz}\n{rechtsform}\n{registergericht} {registernummer}\nGeschäftsführung {geschaeftsfuehrung}\nVorsitz des Aufsichtsrats {aufsichtsratsvorsitz}";
const eigene = (footerColumns: string[], mehr: Partial<LetterheadOptions> = {}): Letterhead => ({
  options: { ...DEFAULT_OPTIONS, footerColumns, footerCustom: true, ...mehr },
});
const look = (letterhead: Letterhead) => (templateInputs({}, letterhead) as { look: Record<string, unknown> }).look;

describe("Fußdaten mit Pflichtangaben", () => {
  it("ohne Platzhalter setzt Haben die Angaben selbst, über legal", () => {
    const fuss = footerData(gmbhSeller, undefined, eigene([...DEFAULT_FOOTER_COLUMNS]));
    expect(fuss.footer).toHaveLength(3);
    expect(fuss.legal).toContain("Registergericht: Amtsgericht Charlottenburg, HRB 123456 B");
  });

  it("mit allen Platzhaltern stehen die Angaben in der Fußzeile und nirgends sonst", () => {
    const fuss = footerData(gmbhSeller, undefined, eigene(["{firma}", "{iban}", `{steuernummer}\n${MIT_ALLEN}`]));
    expect(fuss.legal).toBeNull();
    expect(fuss.footer[2]).toEqual([
      "13/345/67890",
      "Sitz Berlin",
      "Amtsgericht Charlottenburg HRB 123456 B",
      "Geschäftsführung Erika Mustermann, Max Mustermann",
    ]);
  });

  it("nur einige Platzhalter, etwa aus der Zeit als Einzelunternehmen: Haben setzt die Angaben trotzdem über legal", () => {
    const fuss = footerData(gmbhSeller, undefined, eigene(["{firma}", "{iban}", "{steuernummer}\nSitz {sitz}"]));
    expect(fuss.legal).toContain("Registergericht: Amtsgericht Charlottenburg, HRB 123456 B");
  });

  it("ein eigenes Layout ohne die neuen Felder bekommt die Angaben nur über legal, die Platzhalter bleiben leer", () => {
    const fuss = footerData(gmbhSeller, undefined, { ...eigene(["{firma}", `{steuernummer}\n${MIT_ALLEN}`]), legalFieldOnly: true });
    expect(fuss.legal).toContain("Sitz der Gesellschaft: Berlin");
    expect(fuss.footer[1]).toEqual(["13/345/67890"]);
  });

  it("ausgeschaltete eigene Fußzeile: automatische Fußzeile, die Spalten bleiben gespeichert", () => {
    const fuss = footerData(sampleSeller, undefined, eigene(["{firma}", "{ustid}"], { footerCustom: false }));
    expect(fuss.footerFormatted).toBeNull();
    expect(fuss.footer).toHaveLength(3);
  });

  it("Einzelunternehmen: Platzhalter der Pflichtangaben fallen weg, kein legal", () => {
    const fuss = footerData(sampleSeller, undefined, eigene(["{firma}", `{ustid}\n${MIT_ALLEN}`]));
    expect(fuss.legal).toBeNull();
    expect(fuss.footer[1]).toEqual(["DE123456789"]);
  });
});

describe("Stelle der Pflichtangaben für die Vorlage (Feldvertrag)", () => {
  it("eingebaute Layouts bekommen die Stelle aufgelöst", () => {
    expect(look({ layout: { id: "klar", optionen: { fassung: "klassisch" } } }).legalPosition).toBe("zeile");
    expect(look({ layout: { id: "klar" } }).legalPosition).toBe("spalte");
    expect(look({ layout: { id: "klar" }, options: { ...DEFAULT_OPTIONS, legalPosition: "zeile" } }).legalPosition).toBe("zeile");
  });

  it("eigene Layouts bekommen die Wahl, wie sie ist", () => {
    expect(look({}).legalPosition).toBe("layout");
    expect(look({ options: { ...DEFAULT_OPTIONS, legalPosition: "spalte" } }).legalPosition).toBe("spalte");
  });

  it("kein eigenes Feld dafür, dass die Angaben in der Fußzeile stehen: legal ist dann null", () => {
    expect(look(eigene(["{firma}", MIT_ALLEN]))).not.toHaveProperty("legalInFooter");
  });

  it("erkennt eigene Layouts, die die neuen Felder nennen", () => {
    expect(kenntPflichtangabenFelder('#let p = d.look.at("legalPosition", default: "layout")')).toBe(true);
    expect(kenntPflichtangabenFelder("#d.legal")).toBe(false);
  });
});
