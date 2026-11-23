import { type computeUstva, periodLabel } from "@haben/core";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, type FormEvent } from "react";
import { ElsterSubmit } from "../../../components/ElsterSubmit.tsx";
import { MeinElsterWerte } from "../../../components/MeinElsterWerte.tsx";
import { AbgabeVermerken } from "../../../components/umsatzsteuer/AbgabeVermerken.tsx";
import { UstvaZahlung } from "../../../components/umsatzsteuer/UstvaZahlung.tsx";
import { elsterNotice, zahllastFakt, type ElsterKind } from "../../../lib/elster.ts";
import { errorMessage } from "../../../lib/format.ts";
import type { Notice } from "../../../lib/use-action.ts";
import { createVatCorrection, getMeinElsterUstvaWerte, saveVatDraft, submitVatReturn } from "../../../server/functions/vat.ts";
import type { FieldKey } from "./-zeitraum-kennzahlen.tsx";
import { History, type PageData } from "./-zeitraum-quellen.tsx";

/** Speichern, Senden und Berichtigen der Anmeldung; `busy`, solange eine davon läuft */
export function useVoranmeldungAktionen(
  data: PageData,
  {
    mode,
    manualFigures,
    reason,
    dirty,
    setDirty,
  }: { mode: "berechnet" | "manuell"; manualFigures: Record<FieldKey, number>; reason: string; dirty: boolean; setDirty: (dirty: boolean) => void },
  setNotice: (notice: Notice) => void,
) {
  const router = useRouter();
  const save = useServerFn(saveVatDraft);
  const submit = useServerFn(submitVatReturn);
  const correct = useServerFn(createVatCorrection);
  const current = data.current;
  const [busy, setBusy] = useState(false);

  async function persist(): Promise<string> {
    const result = await save({
      data: mode === "berechnet" ? { mode: "berechnet", period: data.period } : { mode: "manuell", period: data.period, ...manualFigures, reason },
    });
    setDirty(false);
    return result.id;
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await work();
    } catch (error) {
      setNotice({ tone: "danger", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  const onSave = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await persist();
      await router.invalidate();
      setNotice({ tone: "ok", text: "Entwurf gespeichert." });
    });
  };

  const onSubmit = (kind: ElsterKind, pin?: string) =>
    run(async () => {
      const id = dirty || !current ? await persist() : current.id;
      const result = await submit({ data: { id, kind, pin } });
      await router.invalidate();
      setNotice(elsterNotice(kind, result, "Voranmeldung übermittelt und festgeschrieben."));
    });

  const onCorrect = () =>
    run(async () => {
      await correct({ data: data.period });
      await router.invalidate();
      setNotice({ tone: "info", text: "Berichtigte Anmeldung angelegt. Werte prüfen und erneut senden." });
    });

  return { busy, onSave, onSubmit, onCorrect };
}

/** Rechte Spalte: an ELSTER senden, Zahlung an das Finanzamt, Abgabe außerhalb von Haben, Werte für Mein ELSTER, Verlauf */
export function AbgabeSpalte({
  data,
  locked,
  valid,
  busy,
  shown,
  dirty,
  stale,
  onSubmit,
  setNotice,
}: {
  data: PageData;
  locked: boolean;
  valid: boolean;
  busy: boolean;
  shown: ReturnType<typeof computeUstva>;
  dirty: boolean;
  stale: boolean;
  onSubmit: (kind: ElsterKind, pin?: string) => Promise<void>;
  setNotice: (notice: Notice) => void;
}) {
  const loadWerte = useServerFn(getMeinElsterUstvaWerte);
  const current = data.current;
  return (
    <div className="stack">
      {!locked && (
        <ElsterSubmit
          setup={data}
          title="An ELSTER übermitteln"
          ready={valid && data.companyIssues.length === 0}
          busy={busy}
          confirmTitle="Voranmeldung verbindlich senden?"
          confirmFacts={[
            { label: "Steuerart", value: "Umsatzsteuer-Voranmeldung" },
            { label: "Zeitraum", value: periodLabel(data.period) },
            zahllastFakt(shown.kz83),
          ]}
          confirmText="Die Voranmeldung geht an das Finanzamt und wird danach festgeschrieben."
          footer="ERiC prüft die Daten vor dem Versand. Das Übertragungsprotokoll wird als PDF abgelegt. Die PIN wird nicht gespeichert."
          onSubmit={onSubmit}
        />
      )}
      <UstvaZahlung posten={data.posten} />
      {!locked && current && (
        <AbgabeVermerken
          returnId={current.id}
          kz83={shown.kz83}
          blocked={dirty || stale}
          today={data.today}
          onFiled={() => setNotice({ tone: "ok", text: "Abgabe vermerkt und Voranmeldung festgeschrieben. Die Zahllast steht jetzt im Bankabgleich." })}
        />
      )}
      {!data.herstellerIdConfigured && !locked && current && (
        <MeinElsterWerte
          load={() => loadWerte({ data: { id: current.id } })}
          label={`Umsatzsteuer-Voranmeldung ${periodLabel(data.period)}`}
          blocked={dirty || stale || data.companyIssues.length > 0}
        />
      )}
      <History data={data} />
    </div>
  );
}
