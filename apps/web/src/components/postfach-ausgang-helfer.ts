import { readInboxOutgoing } from "../server/functions/inbox.ts";

/** „Rechnung-DE-2026090026.pdf“ → „DE-2026090026“: die Nummer steht im Dateinamen */
export const nummerOf = (dateiname: string) => dateiname.replace(/\.pdf$/i, "").replace(/^rechnung[-_ ]*/i, "") || dateiname;

/** „JABA e.K. <info@jaba.hosting>“ → „JABA e.K.“ */
export const absenderOf = (absender: string) => absender.replace(/\s*<[^>]*>\s*$/, "").trim() || absender;

/** Das PDF einer wartenden Ausgangsrechnung als Datei im Browser */
export async function dateiOf(id: string): Promise<File> {
  const datei = await readInboxOutgoing({ data: { id } });
  const bytes = Uint8Array.from(atob(datei.base64), (c) => c.charCodeAt(0));
  return new File([bytes], datei.filename, { type: datei.mimeType });
}
