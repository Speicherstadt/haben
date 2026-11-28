import { useState, type FormEvent } from "react";
import type { getMcpSettings } from "../server/functions/mcp.ts";
import { Field } from "./Field.tsx";

type Data = Awaited<ReturnType<typeof getMcpSettings>>;

const FESTSCHREIBEN = "rechnungen:festschreiben";

/**
 * Neues Token: Name, Gültigkeit und Rechte. Das Recht zum Festschreiben gilt nur für eine Quelle, aus der schon
 * Rechnungen kommen (#1918); ohne solche Rechnungen lässt es sich nicht wählen.
 */
export function TokenAnlegen({
  scopes,
  quellen,
  busy,
  onCreate,
}: {
  scopes: Data["scopes"];
  quellen: string[];
  busy: boolean;
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [festschreiben, setFestschreiben] = useState(false);
  return (
    <form
      className="form-grid"
      onSubmit={(event) => {
        onCreate(event);
        setFestschreiben(false);
      }}
      aria-label="Neues Token"
    >
      <Field label="Name">{(control) => <input {...control} name="name" required maxLength={80} placeholder="Claude Code am Laptop" />}</Field>
      <Field label="Gültig">
        {(control) => (
          <select {...control} name="days" defaultValue="90">
            <option value="30">30 Tage</option>
            <option value="90">90 Tage</option>
            <option value="365">1 Jahr</option>
          </select>
        )}
      </Field>
      <fieldset style={{ border: 0, padding: 0, margin: 0, gridColumn: "1 / -1" }}>
        <legend className="small" style={{ fontWeight: 500, marginBottom: 4 }}>
          Rechte
        </legend>
        {scopes.map((scope) => (
          <label key={scope.id} className="checkbox">
            <input
              type="checkbox"
              name="scopes"
              value={scope.id}
              defaultChecked={scope.id === "haben:lesen"}
              disabled={scope.id === FESTSCHREIBEN && quellen.length === 0}
              onChange={scope.id === FESTSCHREIBEN ? (e) => setFestschreiben(e.currentTarget.checked) : undefined}
            />
            <span>
              {scope.label} <span className="mono small muted">{scope.id}</span>
              {scope.id === FESTSCHREIBEN && quellen.length === 0 && (
                <span className="small muted"> · erst wählbar, wenn ein Dienst Entwürfe mit externer Referenz angelegt hat</span>
              )}
            </span>
          </label>
        ))}
      </fieldset>
      {festschreiben && (
        <Field label="Quelle zum Festschreiben" hint="Das Token schreibt nur Entwürfe dieser Quelle (externalSource) fest, keine anderen.">
          {(control) => (
            <select {...control} name="finalizeSource" required defaultValue="">
              <option value="" disabled>
                Quelle wählen
              </option>
              {quellen.map((quelle) => (
                <option key={quelle} value={quelle}>
                  {quelle}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <div className="actions" style={{ gridColumn: "1 / -1" }}>
        <button type="submit" className="btn" disabled={busy}>
          Token anlegen
        </button>
      </div>
    </form>
  );
}
