import {
  DEFAULT_FOOTER_COLUMNS,
  DEFAULT_OPTIONS,
  EINGEBAUTE_LAYOUTS,
  type EingebautesLayout,
  layoutOptionen,
  layoutPflichtangaben,
  type LegalPosition,
  wertErlaubt,
} from "@haben/core";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dunningPdfData } from "./dunning.ts";
import { layoutTemplate, pdfData, templateInputs } from "./pdf.ts";
import { createRenderClient } from "./render-client.ts";
import { gmbhSeller, sampleBuyer, sampleDocument } from "./samples.ts";
import type { Letterhead } from "./types.ts";
import { PACKAGE_DIR } from "./typst-compiler.ts";

/*
 * Pflichtangaben einer GmbH im Fuß (#1651) in jedem eingebauten Layout, jeder Fassung, Beleg und Mahnung: alle Angaben auf
 * dem Blatt, nichts überlappt, nichts über den Rand; als Spalte neben den übrigen, als Zeile darunter, in der Randspalte
 * untereinander. Gemessen an der Lage der Wörter im PDF (pdftotext -bbox), wie infoblock-platz.test.ts.
 */

const templates = join(PACKAGE_DIR, "templates");
const client = createRenderClient({ timeoutMs: 20_000 });
afterAll(() => client.close());

interface Wort {
  wort: string;
  links: number;
  rechts: number;
  oben: number;
  unten: number;
}

function blatt(pdf: Uint8Array): { breite: number; hoehe: number; woerter: Wort[] } | null {
  const dir = mkdtempSync(join(tmpdir(), "haben-pflicht-"));
  try {
    writeFileSync(join(dir, "beleg.pdf"), pdf);
    const html = execFileSync("pdftotext", ["-bbox", "-f", "1", "-l", "1", join(dir, "beleg.pdf"), "-"], { encoding: "utf8" });
    const seite = html.match(/<page width="([\d.]+)" height="([\d.]+)">/)!;
    const woerter = [...html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({
      wort: m[5]!.replace(/&amp;/g, "&"),
      links: Number(m[1]),
      oben: Number(m[2]),
      rechts: Number(m[3]),
      unten: Number(m[4]),
    }));
    return { breite: Number(seite[1]), hoehe: Number(seite[2]), woerter };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let vorhanden = true;
try {
  execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
} catch {
  vorhanden = false;
}

function kombinationen(layout: EingebautesLayout): Record<string, string>[] {
  let ergebnis: Record<string, string>[] = [{}];
  for (const option of layout.optionen) {
    ergebnis = ergebnis.flatMap((bisher) => {
      const erlaubt = option.werte.filter((wert) => wertErlaubt(wert, bisher));
      return erlaubt.length === 0 ? [bisher] : erlaubt.map((wert) => ({ ...bisher, [option.id]: wert.id }));
    });
  }
  return ergebnis;
}

// Alle Angaben, die § 35a GmbHG kennt, mit langen Namen: Rechtsform, drei Geschäftsführer, Aufsichtsrat
const seller = {
  ...gmbhSeller,
  name: "Mustermann Software",
  legalInfo: {
    ...gmbhSeller.legalInfo!,
    legalForm: "UG (haftungsbeschränkt)",
    managingDirectors: ["Erika Annemarie Mustermann", "Maximilian Alexander Mustermann", "Friederike Schulze-Westerhoff"],
    supervisoryBoardChair: "Hans-Joachim Lüdenscheid",
  },
};
const MARKEN = ["haftungsbeschränkt", "Charlottenburg", "HRB", "Westerhoff", "Lüdenscheid"];
const MIT_ALLEN = "Sitz {sitz}\n{rechtsform}\n{registergericht} {registernummer}\n{geschaeftsfuehrung}\nVorsitz des Aufsichtsrats {aufsichtsratsvorsitz}";

const mahnung = (letterhead: Letterhead) =>
  dunningPdfData({
    level: 1,
    date: "2026-10-15",
    dueDate: "2026-10-25",
    seller,
    buyer: sampleBuyer,
    invoice: { number: "2026-001", issueDate: "2026-09-01", dueDate: "2026-09-15" },
    amounts: { open: 119_000, fee: 0, flatFee: 0, interest: 0, interestRate: 0, interestDays: 0, total: 119_000 },
    intro: "Bitte zahlen.",
    closing: "",
    ...letterhead,
  });

const FAELLE: { name: string; footerColumns: string[] | null; legalPosition: LegalPosition }[] = [
  { name: "automatische Fußzeile", footerColumns: null, legalPosition: "layout" },
  { name: "3 eigene Spalten als Spalte", footerColumns: [...DEFAULT_FOOTER_COLUMNS], legalPosition: "spalte" },
  { name: "3 eigene Spalten als Zeile", footerColumns: [...DEFAULT_FOOTER_COLUMNS], legalPosition: "zeile" },
  {
    name: "Platzhalter in Spalte 3",
    footerColumns: [DEFAULT_FOOTER_COLUMNS[0]!, DEFAULT_FOOTER_COLUMNS[1]!, `{steuernummer}\n${MIT_ALLEN}`],
    legalPosition: "spalte",
  },
];

// Die Kästen zweier Zeilen berühren sich über Ober- und Unterlängen; überlappt ist erst, was sich deutlich deckt
const ueberlappen = (a: Wort, b: Wort) =>
  Math.min(a.rechts, b.rechts) - Math.max(a.links, b.links) > 1 &&
  Math.min(a.unten, b.unten) - Math.max(a.oben, b.oben) > 0.4 * Math.min(a.unten - a.oben, b.unten - b.oben);

const fassungen = EINGEBAUTE_LAYOUTS.flatMap((layout) => kombinationen(layout).map((k) => ({ layout, optionen: layoutOptionen(layout, k) })));

describe.skipIf(!vorhanden)("Pflichtangaben der GmbH im Fuß aller eingebauten Layouts", () => {
  for (const { layout, optionen } of fassungen)
    for (const art of ["beleg", "mahnung"] as const)
      for (const fall of FAELLE) {
        it(`${layout.id} ${JSON.stringify(optionen)} (${art}), ${fall.name}`, async () => {
          const letterhead: Letterhead = {
            options: { ...DEFAULT_OPTIONS, footerColumns: fall.footerColumns, footerCustom: true, legalPosition: fall.legalPosition },
            layout: { id: layout.id, optionen },
          };
          const daten = art === "beleg" ? pdfData({ ...sampleDocument(), seller, ...letterhead }) : mahnung(letterhead);
          const job = { workspace: templates, main: join(templates, layoutTemplate(art, letterhead)), data: templateInputs(daten, letterhead), files: [] };
          const seite = blatt(await client.renderPdf(job, "2026-10-02"))!;
          const { woerter } = seite;

          // Eine Angabe der Zeile hält mit festen Leerzeichen zusammen; pdftotext liest sie als ein Wort
          const teile = woerter.flatMap((w) => w.wort.split("\u00A0"));
          for (const marke of MARKEN) expect(teile.filter((teil) => teil.includes(marke)).length, `${marke} genau einmal`).toBe(1);
          expect(
            woerter.filter((w) => w.rechts > seite.breite || w.unten > seite.hoehe || w.links < 0).map((w) => w.wort),
            "über den Rand",
          ).toEqual([]);
          const doppelt = woerter.flatMap((a, i) =>
            woerter
              .slice(i + 1)
              .filter((b) => ueberlappen(a, b))
              .map((b) => `${a.wort}/${b.wort}`),
          );
          expect(doppelt, "überlappt").toEqual([]);

          // Wo die Angaben stehen; die Randspalte setzt sie untereinander unter die übrigen Angaben
          const stelle = layoutPflichtangaben(layout, optionen);
          if (stelle === "rand") return;
          const erste = (wort: string) => woerter.find((w) => w.wort.split("\u00A0").includes(wort))!;
          const gericht = woerter.find((w) => w.wort.includes("Charlottenburg"))!;
          // Erste Zeile der Spalten 2 und 3: Bank und Steuernummer
          const bank = erste("Commerzbank");
          const steuer = woerter.find((w) => w.wort.includes("13/345/67890"))!;
          if (fall.name === "Platzhalter in Spalte 3") {
            expect(
              woerter.some((w) => w.wort.startsWith("Registergericht:")),
              "nicht noch einmal über legal",
            ).toBe(false);
            expect(gericht.links, "in Spalte 3").toBeGreaterThanOrEqual(steuer.links - 1);
            return;
          }
          const alsZeile = fall.legalPosition === "zeile" || (fall.legalPosition === "layout" && stelle === "zeile");
          // Nicht die Absenderzeile über der Anschrift
          const strasse = woerter.find((w) => w.wort === "Lindenstraße" && w.oben > seite.hoehe * 0.7)!;
          // Erste Angabe ist die Rechtsform (legalLines in pdf.ts)
          const sitz = woerter.find((w) => w.wort.split("\u00A0")[0] === "Rechtsform:" && w.oben > seite.hoehe * 0.7)!;
          if (alsZeile) {
            expect(sitz.links, "Zeile beginnt an der Fluchtlinie").toBeCloseTo(strasse.links, 0);
            const unterste = Math.max(...woerter.filter((w) => w.oben > seite.hoehe * 0.7 && w.oben < sitz.oben - 1).map((w) => w.unten));
            expect(sitz.oben, "unter den Spalten").toBeGreaterThan(unterste);
          } else {
            expect(sitz.links, "vierte Spalte rechts der dritten").toBeGreaterThan(steuer.links);
            expect(sitz.oben, "oben bündig mit den Spalten").toBeCloseTo(bank.oben, 0);
          }
        });
      }
});
