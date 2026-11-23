import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import type { useAction } from "../lib/use-action.ts";
import { copyInvoiceAsDraft, copyInvoiceAsReplacementDraft } from "../server/functions/invoices.ts";

type ActionState = Pick<ReturnType<typeof useAction>, "busy" | "run">;
type CopySource = { id: string; kind: string; variant: string | null };
/**
 * Im Editor: `pruefe` prüft die Angaben vor `run`, solange die Felder frei sind; während die Aktion läuft, sind sie gesperrt,
 * und der Fokus fände das Feld mit Fehler nicht (#1148). `speichern` speichert Ungespeichertes und gibt die Id zum Kopieren zurück
 */
type Prepare = { pruefe: () => boolean; speichern: () => Promise<string | null> };

/**
 * Nächste ähnliche Rechnung: neuer Entwurf mit Kunde und Positionen, aus einer festgeschriebenen Rechnung oder einem
 * Entwurf. Abschlag und Schlussrechnung entstehen aus dem Angebot, Storno und Korrektur aus der Rechnung; dort gibt es
 * kein Kopieren (null). Fehler meldet die Seite über `action`.
 */
export function useInvoiceCopy(invoice: CopySource | null, action: ActionState, prepare?: Prepare, replacement = false): (() => void) | null {
  const copy = useServerFn(replacement ? copyInvoiceAsReplacementDraft : copyInvoiceAsDraft);
  const navigate = useNavigate();
  if (invoice?.kind !== "rechnung" || invoice.variant !== null) return null;
  return () => {
    if (prepare && !prepare.pruefe()) return;
    void action.run(async () => {
      const sourceId = prepare ? await prepare.speichern() : invoice.id;
      if (!sourceId) return;
      const draft = await copy({ data: sourceId });
      await navigate({ to: "/rechnungen/$id", params: { id: draft.id } });
    });
  };
}

export function InvoiceCopyButton({
  invoice,
  action,
  prepare,
  replacement = false,
}: {
  invoice: CopySource | null;
  action: ActionState;
  prepare?: Prepare;
  replacement?: boolean;
}) {
  const onCopy = useInvoiceCopy(invoice, action, prepare, replacement);
  if (!onCopy) return null;
  return (
    <button type="button" className={replacement ? "btn btn-primary" : "btn"} onClick={onCopy} disabled={action.busy}>
      {replacement ? "Ersatzrechnung erstellen" : "Kopieren"}
    </button>
  );
}
