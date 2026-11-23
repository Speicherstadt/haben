import { readWisoAssetRegister, WisoParseError, type WisoRegisterAsset } from "@haben/import";
import { UserError } from "../../errors.ts";
import { sniff } from "../../storage.ts";
import { pdfPageTexts } from "../belege/index.ts";
import { csv, money } from "./csv.ts";

const MAX_PAGES = 100;

function draftCsv(assets: WisoRegisterAsset[]): Uint8Array {
  return csv(
    ["Bezeichnung", "Anschaffungsdatum", "Anschaffungskosten", "Nutzungsdauer (Jahre)", "Restbuchwert", "Art", "Abschreibung", "Degressiver Satz", "Notiz"],
    assets.map((asset) => [
      `${asset.name} [WISO ${asset.inventoryNumber}]`,
      asset.acquisitionDate,
      money(asset.cost),
      asset.usefulLifeYears,
      money(asset.closingBookValue),
      "Bitte ergänzen",
      "Bitte ergänzen",
      "",
      `WISO-Nr. ${asset.inventoryNumber}, Konto ${asset.account}, Seite ${asset.page}` +
        (asset.change || asset.disposalDate ? ". Zugang oder Abgang anhand der Anlagendetails prüfen." : ""),
    ]),
  );
}

export async function previewWisoAssets(bytes: Uint8Array) {
  if (sniff(bytes)?.mimeType !== "application/pdf") throw new UserError("Bitte ein WISO-Anlagenverzeichnis als PDF auswählen.");
  const extracted = await pdfPageTexts(bytes, MAX_PAGES);
  if (!extracted || extracted.pages.every((page) => !page.trim())) {
    throw new UserError("Das PDF ließ sich nicht als Text lesen. Wähle ein ungeschütztes WISO-PDF mit Textebene.");
  }
  if (extracted.truncated) throw new UserError(`Das PDF darf höchstens ${MAX_PAGES} Seiten haben.`);
  try {
    const preview = readWisoAssetRegister(extracted.pages);
    return {
      ...preview,
      draft: { filename: `WISO-Anlagen-${preview.year}-Entwurf.csv`, base64: Buffer.from(draftCsv(preview.assets)).toString("base64") },
    };
  } catch (error) {
    if (error instanceof WisoParseError) throw new UserError(error.message);
    throw error;
  }
}
