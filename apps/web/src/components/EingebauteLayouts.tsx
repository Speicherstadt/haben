import { type FormEvent, useState } from "react";
import { EINGEBAUTE_LAYOUTS, type EingebautesLayout, layoutOptionen, layoutVarianten, type LetterheadDesign } from "@haben/core";
import { Field } from "./Field.tsx";
import { FormDialog } from "./FormDialog.tsx";
import { LayoutOptionFields } from "./LayoutOptionFields.tsx";
import { Segmented } from "./Segmented.tsx";

const DOWNLOAD = "/api/belegvorlagen";

type Umfang = "variante" | "layout" | "alle";
type Art = "beleg" | "mahnung";

/** Adresse des Downloads einer Variante: Layout, Art und je Option der aufgelöste Wert */
function downloadHref(layout: EingebautesLayout, gewaehlt: Readonly<Record<string, string>>, art: Art): string {
  const params = new URLSearchParams({ datei: "eingebaut", layout: layout.id, art, ...layoutOptionen(layout, gewaehlt) });
  return `${DOWNLOAD}?${params}`;
}

/** Adresse des ZIPs: alle Varianten eines Layouts oder, ohne Layout, aller eingebauten */
function zipHref(layout?: EingebautesLayout): string {
  return `${DOWNLOAD}?${new URLSearchParams({ datei: "varianten", ...(layout ? { layout: layout.id } : {}) })}`;
}

const dateien = (layouts: readonly EingebautesLayout[]) => layouts.reduce((summe, layout) => summe + layoutVarianten(layout).length * 2, 0);

/**
 * Ein eingebautes Layout als Grundlage für ein eigenes (#113): Knopf und Dialog. Erst was (eine Variante, alle Varianten
 * eines Layouts, alle Layouts), dann welches Layout und, für eine Variante, Belegart und Optionen. Die Optionen beginnen bei
 * der Wahl aus der Gestaltung und ändern sie nicht.
 */
export function EingebauteLayouts({ design }: { design: LetterheadDesign }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        Eingebautes Layout herunterladen
      </button>
      <FormDialog open={open} title="Eingebautes Layout herunterladen" onClose={() => setOpen(false)}>
        <DownloadForm design={design} onDone={() => setOpen(false)} />
      </FormDialog>
    </>
  );
}

function DownloadForm({ design, onDone }: { design: LetterheadDesign; onDone: () => void }) {
  const [umfang, setUmfang] = useState<Umfang>("variante");
  const [layoutId, setLayoutId] = useState(EINGEBAUTE_LAYOUTS[0]!.id);
  const [art, setArt] = useState<Art>("beleg");
  const [wahl, setWahl] = useState<LetterheadDesign["layoutOptions"]>(design.layoutOptions);
  const layout = EINGEBAUTE_LAYOUTS.find((l) => l.id === layoutId) ?? EINGEBAUTE_LAYOUTS[0]!;
  const href = umfang === "variante" ? downloadHref(layout, wahl[layout.id] ?? {}, art) : zipHref(umfang === "layout" ? layout : undefined);
  const ergebnis =
    umfang === "variante"
      ? "Eine Typst-Datei, die Variante fest darin."
      : `Ein ZIP mit ${dateien(umfang === "layout" ? [layout] : EINGEBAUTE_LAYOUTS)} Typst-Dateien, je Variante für Belege und Mahnungen.`;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Die Antwort ist ein Anhang: Der Browser lädt herunter und bleibt auf der Seite
    window.location.assign(href);
    onDone();
  }

  return (
    <form className="builtin-download" onSubmit={onSubmit}>
      <p className="small muted" style={{ margin: 0 }}>
        Als Grundlage für ein eigenes Layout. Die Auswahl hier ändert die Gestaltung nicht.
      </p>
      <fieldset className="field">
        <legend>Was</legend>
        <label className="checkbox">
          <input type="radio" name="umfang" checked={umfang === "variante"} onChange={() => setUmfang("variante")} />
          Ein Layout in einer Variante
        </label>
        <label className="checkbox">
          <input type="radio" name="umfang" checked={umfang === "layout"} onChange={() => setUmfang("layout")} />
          Alle Varianten eines Layouts
        </label>
        <label className="checkbox">
          <input type="radio" name="umfang" checked={umfang === "alle"} onChange={() => setUmfang("alle")} />
          Alle eingebauten Layouts
        </label>
      </fieldset>
      {umfang !== "alle" && (
        <Field label="Layout" hint={layout.beschreibung}>
          {(control) => (
            <select {...control} value={layout.id} onChange={(e) => setLayoutId(e.target.value)}>
              {EINGEBAUTE_LAYOUTS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      {umfang === "variante" && (
        <>
          <fieldset className="field">
            <legend>Für</legend>
            <Segmented
              label="Belegart"
              options={[
                { value: "beleg", label: "Belege", name: "Belege" },
                { value: "mahnung", label: "Mahnungen", name: "Mahnungen" },
              ]}
              value={art}
              onChange={setArt}
            />
          </fieldset>
          <LayoutOptionFields layoutId={layout.id} design={{ ...design, layoutOptions: wahl }} onChange={setWahl} />
        </>
      )}
      <p className="small muted" role="status" style={{ margin: 0 }}>
        {ergebnis}
      </p>
      <div className="actions">
        <button type="button" className="btn" onClick={onDone}>
          Abbrechen
        </button>
        <button type="submit" className="btn btn-primary">
          Herunterladen
        </button>
      </div>
    </form>
  );
}
