import { readWisoContactList, WisoParseError } from "@haben/import";
import { UserError } from "../../errors.ts";
import { sniff } from "../../storage.ts";
import { pdfPageTexts } from "../belege/index.ts";
import { csv } from "./csv.ts";

const MAX_PAGES = 100;

export async function previewWisoContacts(bytes: Uint8Array) {
  if (sniff(bytes)?.mimeType !== "application/pdf") throw new UserError("Bitte die WISO-Kontaktliste als PDF auswählen.");
  const extracted = await pdfPageTexts(bytes, MAX_PAGES);
  if (!extracted || extracted.pages.every((page) => !page.trim())) {
    throw new UserError("Das PDF ließ sich nicht als Text lesen. Wähle ein ungeschütztes WISO-PDF mit Textebene.");
  }
  if (extracted.truncated) throw new UserError(`Das PDF darf höchstens ${MAX_PAGES} Seiten haben.`);
  try {
    const preview = readWisoContactList(extracted.pages);
    const draft = csv(
      ["Kundennummer", "Name", "Straße", "PLZ", "Ort", "Land", "Rolle"],
      preview.contacts.map((c) => [c.number, c.name, c.street, c.postalCode, c.city, c.country ?? "Bitte prüfen", "Bitte prüfen"]),
    );
    return { ...preview, draft: { filename: "WISO-Kontakte-Entwurf.csv", base64: Buffer.from(draft).toString("base64") } };
  } catch (error) {
    if (error instanceof WisoParseError) throw new UserError(error.message);
    throw error;
  }
}
