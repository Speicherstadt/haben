import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { errorMessage } from "../lib/format.ts";
import { useSubmitCheck } from "../lib/use-submit-check.ts";
import { cancelFints, continueFints } from "../server/functions/fints.ts";
import { Field } from "./Field.tsx";

/** Antwort der Bank auf einen Auftrag über FinTS: fertig oder ein offener Schritt (#654) */
export type Schritt = Awaited<ReturnType<typeof continueFints>>;
export type Offen = Exclude<Schritt, { art: "fertig" }>;

/**
 * Gibt die Antwort der Bank an onSchritt, solange das Formular noch steht. Kommt sie erst, nachdem es zugeklappt ist, gilt
 * das Zuklappen wie „Abbrechen“: Ein offener Schritt wird bei der Bank verworfen, statt den an einer Zeile zu ersetzen,
 * und die Seite lädt neu (#1660)
 */
export function useAntwort(onSchritt: (s: Schritt) => Promise<void>) {
  const router = useRouter();
  const verwerfen = useServerFn(cancelFints);
  const zu = useRef(false);
  useEffect(() => {
    zu.current = false;
    return () => {
      zu.current = true;
    };
  }, []);
  return async (s: Schritt) => {
    if (!zu.current) return onSchritt(s);
    if (s.art !== "fertig") await verwerfen({ data: s.vorgang }).catch(() => undefined);
    await router.invalidate();
  };
}

/** Was die Bank gerade will: ein TAN-Verfahren oder -Medium wählen, eine TAN eingeben oder in der App freigeben */
export function SchrittForm({ schritt, onSchritt, onAbbrechen }: { schritt: Offen; onSchritt: (s: Schritt) => Promise<void>; onAbbrechen: () => void }) {
  const weiter = useServerFn(continueFints);
  const verwerfen = useServerFn(cancelFints);
  const antwort = useAntwort(onSchritt);
  const medien = schritt.art === "verfahren" && schritt.verfahren.length === 1 ? schritt.verfahren[0]!.medien : [];
  const [wahl, setWahl] = useState(schritt.art === "verfahren" ? (medien[0] ?? String(schritt.verfahren[0]?.id ?? "")) : "");
  const [tan, setTan] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    form,
    error: fehler,
    check,
  } = useSubmitCheck({
    tan: schritt.art === "tan" && !schritt.entkoppelt && !tan.trim() ? "Bitte die TAN eingeben." : null,
  });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !check()) return;
    setBusy(true);
    setError(null);
    try {
      const data =
        schritt.art === "tan"
          ? { vorgang: schritt.vorgang, tan: schritt.entkoppelt ? undefined : tan }
          : medien.length > 0
            ? { vorgang: schritt.vorgang, verfahren: schritt.verfahren[0]!.id, medium: wahl }
            : { vorgang: schritt.vorgang, verfahren: Number(wahl) };
      await antwort(await weiter({ data }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function abbrechen() {
    void verwerfen({ data: schritt.vorgang }).catch(() => undefined);
    onAbbrechen();
  }

  return (
    <form ref={form} onSubmit={onSubmit} className="stack" style={{ gap: 12, maxWidth: 560 }} aria-label="Freigabe bei der Bank" noValidate>
      {schritt.art === "verfahren" ? (
        <Field
          label={medien.length > 0 ? "TAN-Medium" : "TAN-Verfahren"}
          hint="Wie du Aufträge bei deiner Bank freigibst; die Bank nennt nur, was für deinen Zugang geht."
        >
          {(control) => (
            <select {...control} value={wahl} onChange={(e) => setWahl(e.target.value)}>
              {medien.length > 0
                ? medien.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))
                : schritt.verfahren.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
            </select>
          )}
        </Field>
      ) : (
        <>
          <p style={{ margin: 0, whiteSpace: "pre-line" }}>{schritt.text}</p>
          {schritt.bild && <img src={schritt.bild} alt="Grafik der Bank für die photoTAN" style={{ maxWidth: 240 }} />}
          {schritt.hinweis && (
            <div className="banner banner-info" role="status">
              {schritt.hinweis}
            </div>
          )}
          {!schritt.entkoppelt && (
            <Field label="TAN" error={fehler("tan")}>
              {(control) => (
                <input {...control} value={tan} onChange={(e) => setTan(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required autoFocus />
              )}
            </Field>
          )}
        </>
      )}
      {error && (
        <div className="banner banner-danger" role="alert">
          {error}
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={abbrechen} disabled={busy}>
          Abbrechen
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Warte auf die Bank …" : schritt.art === "verfahren" ? "Weiter" : schritt.entkoppelt ? "Freigegeben, weiter" : "TAN senden"}
        </button>
      </div>
    </form>
  );
}
