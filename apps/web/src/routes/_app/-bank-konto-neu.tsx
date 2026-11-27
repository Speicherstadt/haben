import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, type FormEvent } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Field } from "../../components/Field.tsx";
import type { ImportMessage } from "../../components/BankImportMeldungen.tsx";
import { errorMessage } from "../../lib/format.ts";
import { addBankAccount } from "../../server/functions/bank.ts";

/**
 * Formular „Konto hinzufügen“: ein Bankkonto ohne Abruf; über „Bank hinzufügen › Kontoauszüge als Datei“ (datei) mit dem
 * Hinweis auf den Import. Zahlungsdienstleister legt die Einrichtung unter „Zahlungsdienstleister hinzufügen“ an (#2008).
 */
export function NeuesKontoForm({
  datei = false,
  onClose,
  onCreated,
  onMessage,
  onZahlungsdienstleister,
}: {
  datei?: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
  onMessage: (messages: ImportMessage[]) => void;
  /** Öffnet „Zahlungsdienstleister hinzufügen“ */
  onZahlungsdienstleister: () => void;
}) {
  const router = useRouter();
  const addAccount = useServerFn(addBankAccount);
  const [busy, setBusy] = useState(false);

  async function anlegen(name: string, iban: string) {
    setBusy(true);
    try {
      const { id } = await addAccount({ data: { name, iban } });
      onClose();
      onCreated(id);
      await router.invalidate();
      onMessage([{ tone: "ok", text: "Konto angelegt. Jetzt die Umsätze importieren." }]);
    } catch (error) {
      onMessage([{ tone: "danger", text: errorMessage(error) }]);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void anlegen(String(form.get("name")), String(form.get("iban")));
  }

  return (
    <form className="card" onSubmit={onSubmit} style={{ width: "100%", maxWidth: 420 }} aria-label="Konto hinzufügen">
      {datei && (
        <p className="small muted" style={{ margin: 0 }}>
          Danach importierst du die Kontoauszüge mit „CSV / CAMT importieren“. DKB-Dateien und CAMT nennen die IBAN; dafür legt der Import das Konto auch selbst
          an.
        </p>
      )}
      <Field label="Name">{(control) => <input {...control} style={{ width: "100%", minWidth: 0 }} name="name" required placeholder="N26 Business" />}</Field>
      <Field label="IBAN">{(control) => <input {...control} style={{ width: "100%", minWidth: 0 }} name="iban" required />}</Field>
      <p className="small muted" style={{ margin: 0 }}>
        PayPal, Stripe, Amazon und andere Zahlungsdienstleister:{" "}
        <button type="button" className="link-button" onClick={onZahlungsdienstleister}>
          Zahlungsdienstleister hinzufügen
        </button>
      </p>
      <div className="actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Abbrechen
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Konto anlegen
        </button>
      </div>
    </form>
  );
}

/** Rückfrage vor einem zweiten Konto für denselben Marktplatz */
export function MarktplatzRueckfrage({ marketplace, onConfirm, onClose }: { marketplace: string | undefined; onConfirm: () => void; onClose: () => void }) {
  return (
    <ConfirmDialog
      open={marketplace !== undefined}
      title={marketplace ? `Noch ein Konto für ${marketplace} anlegen?` : ""}
      confirmLabel="Konto trotzdem anlegen"
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <p>
        Für {marketplace} gibt es schon ein Konto. Ein zweites ist möglich, etwa für ein zweites Verkäuferkonto am selben Marktplatz. Die Marktplatzprüfung
        sieht dann beide als passend an — beim Import wählst du selbst das richtige Konto.
      </p>
    </ConfirmDialog>
  );
}
