import { formatEuro } from "@haben/core";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, type FormEvent } from "react";
import { saveBase64File } from "../../lib/download.ts";
import { useAction } from "../../lib/use-action.ts";
import { useSubmitCheck } from "../../lib/use-submit-check.ts";
import { previewWisoAssetsFn } from "../../server/functions/wiso-assets.ts";
import { Field } from "../Field.tsx";
import { FilePicker } from "../FilePicker.tsx";
import { NoticeBanner } from "../NoticeBanner.tsx";
import { ScrollBox } from "../ScrollTable.tsx";

type Preview = Awaited<ReturnType<typeof previewWisoAssetsFn>>;

export function WisoAssets() {
  const previewFn = useServerFn(previewWisoAssetsFn);
  const action = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const submit = useSubmitCheck({ file: file ? null : "Bitte ein WISO-Anlagenverzeichnis auswählen." });
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!submit.check() || !file) return;
    const data = new FormData();
    data.append("file", file);
    void action.run(async () => {
      setPreview(null);
      setPreview(await previewFn({ data }));
    });
  }
  return (
    <section className="card stack" aria-labelledby="wiso-assets-heading">
      <h2 id="wiso-assets-heading">WISO-Anlagenverzeichnis als PDF prüfen</h2>
      <form ref={submit.form} className="stack" noValidate onSubmit={onSubmit}>
        <Field label="WISO-Anlagenverzeichnis" hint="PDF mit Textebene, höchstens 20 MB und 100 Seiten." error={submit.error("file")}>
          {(control) => (
            <FilePicker
              {...control}
              accept=".pdf,application/pdf"
              disabled={action.busy}
              required
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setPreview(null);
                action.setNotice(null);
              }}
            />
          )}
        </Field>
        <div className="actions">
          <button type="submit" className="btn" disabled={action.busy}>
            {action.busy ? "Lese PDF …" : "Anlagen prüfen"}
          </button>
        </div>
      </form>
      <NoticeBanner notice={action.notice} />
      {preview && <WisoAssetResult preview={preview} />}
    </section>
  );
}

function WisoAssetResult({ preview }: { preview: Preview }) {
  return (
    <div className="stack">
      <p role="status">
        {preview.assets.length} {preview.assets.length === 1 ? "Anlage" : "Anlagen"} für {preview.year} erkannt. Übernahmestichtag für diese Werte: 01.01.
        {preview.year + 1}.
      </p>
      {preview.warnings.length > 0 && (
        <ul className="upload-messages">
          {preview.warnings.map((warning) => (
            <li className="banner banner-warn" key={warning}>
              {warning}
            </li>
          ))}
        </ul>
      )}
      <ScrollBox label="Erkannte WISO-Anlagen">
        <table className="data-table" aria-label="Erkannte WISO-Anlagen">
          <thead>
            <tr>
              <th scope="col">Nr.</th>
              <th scope="col">Bezeichnung</th>
              <th scope="col">Konto</th>
              <th scope="col">Anschaffungskosten</th>
              <th scope="col">Restbuchwert am 31.12.</th>
            </tr>
          </thead>
          <tbody>
            {preview.assets.map((asset) => (
              <tr key={asset.inventoryNumber}>
                <th scope="row">{asset.inventoryNumber}</th>
                <td>{asset.name}</td>
                <td>{asset.account}</td>
                <td className="num">{formatEuro(asset.cost)}</td>
                <td className="num">{formatEuro(asset.closingBookValue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollBox>
      <p className="small muted">
        Prüfe die Werte und ergänze im CSV-Entwurf Art und Abschreibung anhand der Anlagendetails. Lade die bearbeitete Datei im Anlagenimport hoch.
      </p>
      <div className="actions">
        <button type="button" className="btn" onClick={() => saveBase64File(preview.draft, "text/csv;charset=utf-8")}>
          CSV-Entwurf laden
        </button>
        <Link className="btn" to="/csv-import" search={{ art: "anlagen", stichtag: `${preview.year + 1}-01-01` }}>
          Zum Anlagenimport
        </Link>
      </div>
    </div>
  );
}
