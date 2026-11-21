// Temporär (nicht committen): Blätter mit GmbH für die Bilder im PR #1651
import { DEFAULT_OPTIONS, DEFAULT_FOOTER_COLUMNS } from "@haben/core";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { renderInvoicePdf } from "./src/pdf.ts";
import { gmbhSeller, sampleDocument } from "./src/samples.ts";

const out = process.argv[2]!;
const suffix = process.argv[3]!;
const extra = JSON.parse(process.argv[4] ?? "{}");
const vier = [...DEFAULT_FOOTER_COLUMNS, "Telefon {telefon}\n{email}"];
const faelle: [string, { id: string; optionen?: Record<string, string> }, string[] | null][] = [
  ["klassisch-auto", { id: "klar", optionen: { fassung: "klassisch" } }, null],
  ["klar-auto", { id: "klar" }, null],
  ["modern-3spalten", { id: "modern" }, [...DEFAULT_FOOTER_COLUMNS]],
  ["klar-3spalten", { id: "klar" }, [...DEFAULT_FOOTER_COLUMNS]],
  ["klar-4spalten", { id: "klar" }, vier],
  ["elegant-rechts", { id: "elegant", optionen: { fuss: "rechts" } }, null],
];
for (const [name, layout, footerColumns] of faelle) {
  const doc = {
    ...sampleDocument(),
    seller: gmbhSeller,
    layout,
    options: { ...DEFAULT_OPTIONS, footerColumns, ...(footerColumns ? { footerCustom: true } : {}), ...extra },
  };
  const pdf = renderInvoicePdf(doc as never);
  const datei = `${out}/blatt-${name}-${suffix}`;
  writeFileSync(`${datei}.pdf`, pdf);
  execFileSync("pdftoppm", ["-png", "-r", "110", "-f", "1", "-l", "1", "-singlefile", `${datei}.pdf`, datei]);
  // Fuß: untere 60 mm der Seite
  execFileSync("pdftoppm", [
    "-png",
    "-r",
    "160",
    "-f",
    "1",
    "-l",
    "1",
    "-singlefile",
    "-y",
    String(Math.round(((297 - 60) / 25.4) * 160)),
    "-H",
    String(Math.round((60 / 25.4) * 160)),
    "-x",
    "0",
    "-W",
    String(Math.round((210 / 25.4) * 160)),
    `${datei}.pdf`,
    `${datei}-fuss`,
  ]);
}
