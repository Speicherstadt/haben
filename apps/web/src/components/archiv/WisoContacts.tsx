import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, type FormEvent } from "react";
import { saveBase64File } from "../../lib/download.ts";
import { useAction } from "../../lib/use-action.ts";
import { useSubmitCheck } from "../../lib/use-submit-check.ts";
import { previewWisoContactsFn } from "../../server/functions/wiso-contacts.ts";
import { Field } from "../Field.tsx";
import { FilePicker } from "../FilePicker.tsx";
import { NoticeBanner } from "../NoticeBanner.tsx";
import { ScrollBox } from "../ScrollTable.tsx";

type Preview = Awaited<ReturnType<typeof previewWisoContactsFn>>;

export function WisoContacts() {
  const previewFn = useServerFn(previewWisoContactsFn);
  const action = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const submit = useSubmitCheck({ file: file ? null : "Bitte eine WISO-Kontaktliste auswählen." });

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
    <section className="card stack" aria-labelledby="wiso-contacts-heading">
      <h2 id="wiso-contacts-heading">WISO-Kontaktliste als PDF prüfen</h2>
      <form ref={submit.form} className="stack" noValidate onSubmit={onSubmit}>
        <Field label="WISO-Kontaktliste" hint="PDF mit Textebene, höchstens 20 MB und 100 Seiten." error={submit.error("file")}>
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
            {action.busy ? "Lese PDF …" : "Kontakte prüfen"}
          </button>
        </div>
      </form>
      <NoticeBanner notice={action.notice} />
      {preview && <WisoContactResult preview={preview} />}
    </section>
  );
}

function WisoContactResult({ preview }: { preview: Preview }) {
  return (
    <div className="stack">
      <p role="status">
        {preview.contacts.length} {preview.contacts.length === 1 ? "Kontakt" : "Kontakte"} erkannt.
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
      <ScrollBox label="Erkannte WISO-Kontakte">
        <table className="data-table" aria-label="Erkannte WISO-Kontakte">
          <thead>
            <tr>
              <th scope="col">Nr.</th>
              <th scope="col">Name</th>
              <th scope="col">Anschrift</th>
              <th scope="col">Land</th>
            </tr>
          </thead>
          <tbody>
            {preview.contacts.map((contact) => (
              <tr key={contact.number}>
                <th scope="row">{contact.number}</th>
                <td>{contact.name}</td>
                <td>
                  {contact.street}, {contact.postalCode} {contact.city}
                </td>
                <td>{contact.country ?? "Land prüfen"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollBox>
      <p className="small muted">
        Prüfe Namen und Adressen. Ergänze im CSV-Entwurf die Rollen und fehlenden Länder. Entferne Interessenten, die du nicht als Kunden übernehmen möchtest.
      </p>
      <div className="actions">
        <button type="button" className="btn" onClick={() => saveBase64File(preview.draft, "text/csv;charset=utf-8")}>
          CSV-Entwurf laden
        </button>
        <Link className="btn" to="/csv-import" search={{ art: "kontakte" }}>
          Zum Kontaktimport
        </Link>
      </div>
    </div>
  );
}
