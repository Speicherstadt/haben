import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAction } from "../../lib/use-action.ts";
import { NoticeBanner } from "../NoticeBanner.tsx";
import { FilePicker } from "../FilePicker.tsx";
import {
  cancelAccountableImport,
  getAccountableStatus,
  getImportStatus,
  startAccountableImport,
  startLexofficeImport,
  startSevdeskImport,
  uploadAccountableExport,
} from "../../server/functions/archive.ts";
import { startFastbillImport } from "../../server/functions/fastbill.ts";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import { Icon } from "../Icon.tsx";
import { Field } from "../Field.tsx";
import { SOURCES, type ConnectedSource, type ImportRow } from "./umzug-quellen.ts";
import { ImportProgress } from "./MigrationFortschritt.tsx";

export function ImportCard({ source, connected, initial }: { source: ConnectedSource | "accountable"; connected: boolean; initial: ImportRow | null }) {
  const router = useRouter();
  const config = SOURCES[source];
  const startLexoffice = useServerFn(startLexofficeImport);
  const startSevdesk = useServerFn(startSevdeskImport);
  const startFastbill = useServerFn(startFastbillImport);
  const uploadAccountable = useServerFn(uploadAccountableExport);
  const startAccountable = useServerFn(startAccountableImport);
  const cancelAccountable = useServerFn(cancelAccountableImport);
  const pollStatus = useServerFn(getImportStatus);
  const pollAccountable = useServerFn(getAccountableStatus);
  const [run, setRun] = useState<ImportRow | null>(initial);
  const fileInput = useRef<HTMLInputElement>(null);
  const action = useAction();
  const running = run?.status === "laeuft";
  // Die Frage gehört zu genau diesem Lauf: Endet er, darf sie beim nächsten nicht von selbst wiederkommen
  const [cancellingRun, setCancellingRun] = useState<string | null>(null);

  /** Der laufende Abruf je Quelle; Accountable hat eine eigene Statusabfrage (jeder Upload ist ein eigener Lauf) */
  const poll = (id = run?.id) => (source === "accountable" ? pollAccountable({ data: id ? { id } : {} }) : pollStatus({ data: { source } }));

  useEffect(() => {
    if (!running) return;
    let stopped = false;
    const timer = setInterval(async () => {
      const next = await (source === "accountable" ? pollAccountable({ data: { id: run?.id } }) : pollStatus({ data: { source } })).catch(() => null);
      if (stopped || !next) return;
      setRun(next);
      if (next.status !== "laeuft") void router.invalidate();
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [running, pollAccountable, pollStatus, router, source, run?.id]);

  const onStart = () =>
    action.run(async () => {
      const started =
        source === "sevdesk"
          ? await startSevdesk()
          : source === "fastbill"
            ? await startFastbill()
            : source === "accountable"
              ? await startAccountable()
              : await startLexoffice();
      setRun(await poll(started.id));
    });

  /** Accountable hat keine API: Der Export wird hier hochgeladen, danach läuft der Abruf wie bei den anderen */
  const onUpload = (event: FormEvent) => {
    event.preventDefault();
    const chosen = [...(fileInput.current?.files ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    if (chosen.length === 0) return;
    void action.run(async () => {
      for (const [index, file] of chosen.entries()) {
        if (chosen.length > 1) action.setNotice({ tone: "info", text: `Datei ${index + 1} von ${chosen.length}: ${file.name}` });
        const form = new FormData();
        form.append("files", file);
        await uploadAccountable({ data: form });
        const { id } = await startAccountable();
        const next = await poll(id);
        setRun(next);
        if (next && next.status !== "laeuft") await router.invalidate();
      }
      if (fileInput.current) fileInput.current.value = "";
    });
  };

  const progress = run?.progress;
  const done = run?.status === "fertig" && (progress?.failed.length ?? 0) === 0;
  const accountable = source === "accountable";
  return (
    <section className={`card stack${done ? " step-done" : ""}`} aria-labelledby="import-heading">
      <div className="step-head">
        <span className="step-num">{done ? <Icon name="check" /> : "2"}</span>
        <h2 id="import-heading" style={{ margin: 0 }}>
          {accountable ? "Accountable-Export übernehmen" : "Kontakte, Rechnungen und Belege abrufen"}
        </h2>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {config.importHelp}
      </p>
      {accountable && !running && (
        <form className="stack" onSubmit={onUpload} style={{ gap: 12 }}>
          <Field label="Exportdatei (ZIP)">{(control) => <FilePicker {...control} inputRef={fileInput} multiple accept=".zip,application/zip" />}</Field>
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={action.busy}>
              {action.busy ? "Übernehme …" : "Hochladen und übernehmen"}
            </button>
          </div>
        </form>
      )}
      {progress && run && <ImportProgress source={source} run={run} />}
      <NoticeBanner notice={action.notice} />
      <ConfirmDialog
        open={running && cancellingRun === run?.id}
        title="Abruf abbrechen?"
        confirmLabel="Abruf abbrechen"
        danger
        onConfirm={() => run && void action.run(() => (source === "accountable" ? cancelAccountable : SOURCES[source].cancel)({ data: { id: run.id } }))}
        onClose={() => setCancellingRun(null)}
      >
        <p>
          {accountable
            ? "Du kannst den Export jederzeit neu hochladen. Schon Übernommenes bleibt und wird übersprungen."
            : "Du kannst den Abruf jederzeit neu starten. Schon Übernommenes bleibt und wird übersprungen; Kontakte und Belegliste liest Haben dabei noch einmal."}
        </p>
      </ConfirmDialog>
      {running ? (
        <div className="actions">
          <button type="button" className="btn" disabled={action.busy} onClick={() => setCancellingRun(run?.id ?? null)}>
            Abbrechen
          </button>
        </div>
      ) : (
        !accountable && (
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={onStart} disabled={!connected || action.busy}>
              {run ? "Erneut abrufen" : "Alles abrufen"}
            </button>
          </div>
        )
      )}
    </section>
  );
}
