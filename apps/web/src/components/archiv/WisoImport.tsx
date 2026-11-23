import { formatEuro } from "@haben/core";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useRef, useState, type FormEvent } from "react";
import { formatDateTime } from "../../lib/format.ts";
import { useAction } from "../../lib/use-action.ts";
import { useSubmitCheck } from "../../lib/use-submit-check.ts";
import { importWiso, previewWisoImport, type getMigration } from "../../server/functions/archive.ts";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import { Field } from "../Field.tsx";
import { FilePicker } from "../FilePicker.tsx";
import { Icon } from "../Icon.tsx";
import { NoticeBanner } from "../NoticeBanner.tsx";
import { WisoGoBdCheck } from "./WisoGoBdCheck.tsx";

type MigrationData = Awaited<ReturnType<typeof getMigration>>;
type ImportRow = NonNullable<MigrationData["wisoImport"]>;
type Preview = Awaited<ReturnType<typeof previewWisoImport>>;
type Result = Awaited<ReturnType<typeof importWiso>>;

export function WisoImport({ initial }: { initial: ImportRow | null }) {
  const router = useRouter();
  const previewFn = useServerFn(previewWisoImport);
  const importFn = useServerFn(importWiso);
  const previewAction = useAction();
  const importAction = useAction();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const submitCheck = useSubmitCheck({ file: file ? null : "Bitte eine WISO-Buchungs-CSV auswählen." });
  const [checked, setChecked] = useState<{ file: File; summary: Preview | null } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [confirming, setConfirming] = useState(false);
  const currentCheck = checked?.file === file ? checked : null;
  const preview = currentCheck?.summary ?? null;

  const formData = (csv: File) => {
    const data = new FormData();
    data.append("file", csv);
    return data;
  };
  const onPreview = (event: FormEvent) => {
    event.preventDefault();
    if (!submitCheck.check() || !file) return;
    setChecked({ file, summary: null });
    void previewAction.run(async () => setChecked({ file, summary: await previewFn({ data: formData(file) }) }));
  };
  const onImport = () => {
    if (!preview || !file) return;
    void importAction.run(async () => {
      setResult(await importFn({ data: formData(file) }));
      setConfirming(false);
      setChecked(null);
      await router.invalidate();
    });
  };

  const done = result || (initial?.status === "fertig" ? initial : null);
  return (
    <section className={`card stack${done ? " step-done" : ""}`} aria-labelledby="wiso-import-heading">
      <div className="step-head">
        <span className="step-num">{done ? <Icon name="check" /> : "1"}</span>
        <h2 id="wiso-import-heading" style={{ margin: 0 }}>
          WISO-Buchungen als CSV prüfen und importieren
        </h2>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Wähle den CSV-Export der Buchungen aus WISO Steuer (Modul EÜR) oder WISO EÜR &amp; Kasse (<code>Daten Export › Buchungen als CSV-Datei</code>). Beide
        Programme nutzen dieselben 18 Spalten. Kontenrahmen, Rechtsform und Versteuerungsart liest Haben aus den Firmendaten.
      </p>
      <form ref={submitCheck.form} className="stack" noValidate onSubmit={onPreview}>
        <Field label="WISO-Buchungs-CSV" hint="Der Testlauf schreibt noch nichts in die Datenbank." error={submitCheck.error("file")}>
          {(control) => (
            <FilePicker
              {...control}
              inputRef={fileInput}
              accept=".csv"
              required
              disabled={importAction.busy}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setChecked(null);
                setConfirming(false);
                setResult(null);
              }}
            />
          )}
        </Field>
        <div className="actions">
          <button type="submit" className="btn" disabled={previewAction.busy || importAction.busy}>
            {previewAction.busy ? "Prüfe CSV …" : "Testlauf starten"}
          </button>
        </div>
      </form>
      <NoticeBanner notice={currentCheck ? previewAction.notice : null} />
      {preview && <WisoPreviewFacts preview={preview} busy={importAction.busy} onStart={() => setConfirming(true)} />}
      <NoticeBanner notice={importAction.notice} />
      {result && (
        <div className="banner banner-ok" role="status">
          Import abgeschlossen: {result.imported} Buchungen übernommen{result.skipped > 0 ? `, ${result.skipped} bereits vorhanden` : ""}.
        </div>
      )}
      {!result && initial && (
        <p className="small muted" style={{ margin: 0 }}>
          Letzter Lauf ({formatDateTime(initial.startedAt)}): {initial.progress.imported} übernommen, {initial.progress.skipped} übersprungen ({initial.status}
          ).
        </p>
      )}
      <WisoConfirmDialog preview={preview} open={confirming && preview !== null} onConfirm={onImport} onClose={() => setConfirming(false)} />
      <WisoGoBdCheck />
    </section>
  );
}

function WisoPreviewFacts({ preview, busy, onStart }: { preview: Preview; busy: boolean; onStart: () => void }) {
  return (
    <div className="stack">
      <div className="facts">
        <div>
          <span className="muted">Jahre</span>
          <strong>{preview.years.join(", ")}</strong>
        </div>
        <div>
          <span className="muted">Zeitraum</span>
          <strong>
            {preview.dateFrom} bis {preview.dateTo}
          </strong>
        </div>
        <div>
          <span className="muted">Buchungen</span>
          <strong>{preview.bookings}</strong>
        </div>
        <div>
          <span className="muted">Zeilen</span>
          <strong>{preview.rows}</strong>
        </div>
        <div>
          <span className="muted">Soll laut CSV</span> <strong>{formatEuro(preview.debitTotal)}</strong>
        </div>
        <div>
          <span className="muted">Haben laut CSV</span> <strong>{formatEuro(preview.creditTotal)}</strong>
        </div>
      </div>
      {preview.warnings.length > 0 && (
        <ul className="upload-messages">
          {preview.warnings.map((warning) => (
            <li key={warning} className="banner banner-warn">
              {warning}
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onStart} disabled={busy}>
          {busy ? "Importiere …" : "Diese Daten importieren"}
        </button>
      </div>
    </div>
  );
}

function WisoConfirmDialog({ preview, open, onConfirm, onClose }: { preview: Preview | null; open: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <ConfirmDialog
      open={open}
      title="WISO-Buchungen unveränderlich importieren?"
      confirmLabel="Import starten"
      facts={
        preview
          ? [
              { label: "Jahre", value: preview.years.join(", ") },
              { label: "Buchungen", value: String(preview.bookings) },
              { label: "Zeilen", value: String(preview.rows) },
            ]
          : []
      }
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <p>Die Original-CSV und alle erkannten Buchungen werden unveränderlich archiviert. Bereits vorhandene Einträge werden übersprungen.</p>
    </ConfirmDialog>
  );
}
