/**
 * Der Satz in Schritt 2 über Vorgänge, die nicht mitkommen. Die Sicherung aus der Web-Oberfläche nennt ihre Zahlen
 * je Art (#1640), auch wenn alle null sind; ohne diese Angaben (Abruf über die API, ältere Sicherung) bleibt der Satz
 * über die übergangenen Entwürfe (#1504).
 */
import type { ImportRow } from "./migration-quellen.ts";

type Progress = Pick<NonNullable<ImportRow["progress"]>, "webOmitted" | "ignored">;

const anzahl = (count: number, singular: string, plural: string) => `${count} ${count === 1 ? singular : plural}`;

export function ausgelassenText({ webOmitted, ignored }: Progress): string | null {
  if (webOmitted) {
    const parts = (
      [
        [webOmitted.drafts, "Entwurf", "Entwürfe"],
        [webOmitted.quotations, "Angebot", "Angebote"],
        [webOmitted.orderConfirmations, "Auftragsbestätigung", "Auftragsbestätigungen"],
        [webOmitted.deliveryNotes, "Lieferschein", "Lieferscheine"],
        [webOmitted.other, "sonstigen Vorgang", "sonstige Vorgänge"],
      ] as const
    )
      .filter(([count]) => count > 0)
      .map(([count, singular, plural]) => anzahl(count, singular, plural));
    return `Die Sicherung lässt ${parts.length ? parts.join(", ") : "keine Vorgänge"} aus.`;
  }
  const drafts = ignored?.drafts ?? 0;
  return drafts > 0 ? `Übergangen, kein Beleg: ${anzahl(drafts, "Entwurf", "Entwürfe")}` : null;
}
