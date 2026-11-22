import { DEFAULT_OPTIONS, type LogoPosition, type LogoSize } from "@haben/core";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dunningPdfData } from "./dunning.ts";
import { BEISPIEL_PNG } from "./layout-beispiele.ts";
import { layoutTemplate, pdfData, templateInputs } from "./pdf.ts";
import { createRenderClient } from "./render-client.ts";
import { sampleBuyer, sampleDocument, sampleSeller } from "./samples.ts";
import { PACKAGE_DIR } from "./typst-compiler.ts";

/*
 * Atelier mit Fuß unten (#113): Die Haarlinie unter dem Kopf läuft über die volle Satzbreite. Sie muss über dem Anschriftfeld
 * liegen (ab 45 mm, DIN 5008 Form B), sonst ist sie im Fenster des Umschlags zu sehen, und unter dem größten Logo (L).
 * Das Logo steht unten bündig auf derselben Höhe wie die Grundlinie des Namens, bei jeder Größe (#1655).
 */

const templates = join(PACKAGE_DIR, "templates");
const client = createRenderClient({ timeoutMs: 5_000 });
const MM = 72 / 25.4;
const SATZBREITE = (210 - 25 - 20) * MM;

afterAll(() => client.close());

/**
 * Lage der Kopflinie, Unterkante des Logos und Grundlinie des Namens in mm von oben, aus den verschachtelten translate() der
 * Gruppen im SVG. Der Name ist der erste Text in 21 pt (Gruppe typst-text mit scale(0.021)); ihr Ursprung ist die
 * Grundlinie. Mit Logo in der Mitte oder rechts steht kein Name im Kopf
 */
function kopf(svg: string): { linie: number; logoUnten?: number; name?: number } {
  const stapel: number[] = [];
  let linie: number | undefined;
  let logoUnten: number | undefined;
  let name: number | undefined;
  for (const [tag] of svg.matchAll(/<\/g>|<g\b[^>]*>|<image\b[^>]*>|<path\b[^>]*>/g)) {
    const y = stapel.reduce((summe, wert) => summe + wert, 0);
    if (tag === "</g>") stapel.pop();
    else if (tag.startsWith("<g")) {
      if (tag.includes("typst-text") && tag.includes("scale(0.021,")) name ??= y / MM;
      if (!tag.endsWith("/>")) stapel.push(Number(/translate\([-\d.]+,\s*([-\d.]+)/.exec(tag)?.[1] ?? 0));
    } else if (tag.startsWith("<image")) {
      logoUnten ??= (y + Number(/height="([\d.]+)"/.exec(tag)?.[1])) / MM;
    } else {
      const laenge = Number(/d="M 0 0 L ([\d.]+) 0 "/.exec(tag)?.[1]);
      if (linie === undefined && Math.abs(laenge - SATZBREITE) < 1) linie = y / MM;
    }
  }
  if (linie === undefined) throw new Error("Kopflinie nicht im SVG");
  return { linie, logoUnten, name };
}

const mahnung = dunningPdfData({
  level: 1,
  date: "2026-10-15",
  dueDate: "2026-10-25",
  seller: sampleSeller,
  buyer: sampleBuyer,
  invoice: { number: "2026-001", issueDate: "2026-09-01", dueDate: "2026-09-15" },
  amounts: { open: 119_000, fee: 0, flatFee: 0, interest: 0, interestRate: 0, interestDays: 0, total: 119_000 },
  intro: "Bitte zahlen.",
  closing: "",
});

async function render(vorlage: "beleg" | "mahnung", logoPosition: LogoPosition, logoSize: LogoSize, mitLogo = true) {
  const letterhead = {
    ...(mitLogo ? { logo: { data: BEISPIEL_PNG, format: "png" as const } } : {}),
    options: { ...DEFAULT_OPTIONS, logoPosition, logoSize },
    layout: { id: "atelier", optionen: { fuss: "unten" } },
  };
  const data = vorlage === "beleg" ? pdfData(sampleDocument()) : mahnung;
  const job = {
    workspace: templates,
    main: join(templates, layoutTemplate(vorlage, letterhead)),
    data: templateInputs(data, letterhead),
    files: mitLogo ? [{ name: "logo.png", base64: Buffer.from(BEISPIEL_PNG).toString("base64") }] : [],
  };
  return kopf((await client.render(job)).svg);
}

describe("Atelier mit Fuß unten: Kopflinie", () => {
  for (const vorlage of ["beleg", "mahnung"] as const) {
    for (const stelle of ["links", "mitte", "rechts"] as const) {
      it(`${vorlage}, Logo L ${stelle}: Linie über dem Anschriftfeld (45 mm) und unter dem Logo`, async () => {
        const { linie, logoUnten } = await render(vorlage, stelle, "l");
        expect(linie).toBeLessThan(45);
        expect(linie).toBeGreaterThan(logoUnten! + 2);
      });
    }
    it(`${vorlage}: Unterkante des Logos bei jeder Größe gleich hoch`, async () => {
      const unten = await Promise.all((["s", "m", "l"] as const).map(async (groesse) => (await render(vorlage, "links", groesse)).logoUnten));
      expect(unten[0]).toBeCloseTo(unten[2]!, 1);
      expect(unten[1]).toBeCloseTo(unten[2]!, 1);
    });
    it(`${vorlage}: Name auf der Grundlinie der Unterkante des Logos, ohne Logo ebenso, 4 mm über der Linie`, async () => {
      const mit = await render(vorlage, "links", "m");
      const ohne = await render(vorlage, "links", "m", false);
      expect(mit.name).toBeCloseTo(mit.logoUnten!, 1);
      expect(ohne.name).toBeCloseTo(mit.name!, 1);
      expect(ohne.linie - ohne.name!).toBeCloseTo(4, 1);
    });
  }
});
