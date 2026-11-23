import { describe, expect, it, vi } from "vitest";
import { previewWisoAssets } from "./wiso-assets.ts";

const extract = vi.hoisted(() => vi.fn());
vi.mock("../belege/index.ts", () => ({ pdfPageTexts: extract }));

const pdf = new TextEncoder().encode("%PDF-1.4");

describe("WISO-Anlagenvorschau", () => {
  it("liefert einen CSV-Entwurf mit Quellenangabe und ausdrücklich ungeklärtem AfA-Plan", async () => {
    extract.mockResolvedValueOnce({
      truncated: false,
      pages: [
        [
          "Verzeichnis der abnutzbaren Anlagegüter 2026",
          "Nr Bezeichnung Anschaffungs- Anschaffungs- Zugänge / ND AfA RBW AfA RBW Anlagen-",
          "datum kosten Teilabgänge Vorjahre Vorjahr 2026 31.12.2026 abgang",
          "410 Geschäftsausstattung",
          '  008 =1+1; "Kaffeemaschine"  27.12.2026   588,19   3   0,00   0,00   16,34   571,85',
          "Summen  588,19  0,00  0,00  16,34  571,85",
        ].join("\n"),
      ],
    });
    const result = await previewWisoAssets(pdf);
    expect(result).toMatchObject({ year: 2026, warnings: [], draft: { filename: "WISO-Anlagen-2026-Entwurf.csv" } });
    const csv = Buffer.from(result.draft.base64, "base64").toString("utf8");
    expect(csv).toContain(`"'=1+1; ""Kaffeemaschine"" [WISO 008]";2026-12-27;588,19;3;571,85;Bitte ergänzen;Bitte ergänzen;;WISO-Nr. 008, Konto 410, Seite 1`);
  });

  it("lehnt Fremddateien, fehlenden Text und gekürzte PDFs ab", async () => {
    await expect(previewWisoAssets(new TextEncoder().encode("WISO"))).rejects.toThrow(/als PDF/);
    extract.mockResolvedValueOnce({ truncated: false, pages: ["\n"] });
    await expect(previewWisoAssets(pdf)).rejects.toThrow(/nicht als Text lesen/);
    extract.mockResolvedValueOnce({ truncated: true, pages: ["Verzeichnis der abnutzbaren Anlagegüter 2026"] });
    await expect(previewWisoAssets(pdf)).rejects.toThrow(/100 Seiten/);
    extract.mockResolvedValueOnce({ truncated: false, pages: ["Rechnung für einen Bürostuhl"] });
    await expect(previewWisoAssets(pdf)).rejects.toThrow(/Kein eindeutiges WISO-Anlagenverzeichnis/);
  });
});
