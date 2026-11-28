import { amountError, formatDecimal, formatEuro, MINDESTBESTAND_MAX, parseEuro, type Cents } from "@haben/core";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useState } from "react";
import { useAction } from "../lib/use-action.ts";
import { useSubmitCheck } from "../lib/use-submit-check.ts";
import { saveMindestbestand } from "../server/functions/liquiditaet.ts";
import { Field } from "./Field.tsx";
import { NoticeBanner } from "./NoticeBanner.tsx";

/** Mindestbestand der Liquiditätsvorschau (#1381): der Inhaber stellt ihn ein, die Steuerberatung sieht ihn nur */
export function MindestbestandKarte({ mindestbestand, aendern }: { mindestbestand: Cents | null; aendern: boolean }) {
  return (
    <section className="card" aria-labelledby="liq-mindestbestand-titel">
      <h2 id="liq-mindestbestand-titel">Mindestbestand</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Fällt der erwartete Kontostand darunter, warnen der Hinweis hier, die Übersicht und die Fristen-Mail.
      </p>
      {aendern ? (
        <MindestbestandForm mindestbestand={mindestbestand} />
      ) : (
        <p style={{ margin: 0 }}>{mindestbestand === null ? "Kein Mindestbestand eingestellt." : formatEuro(mindestbestand)}</p>
      )}
    </section>
  );
}

/** Eingabe des Felds: leer heißt kein Mindestbestand (betrag null); fehler sagt, was zu tun ist */
export function mindestbestandEingabe(wert: string): { betrag: Cents | null; fehler: string | null } {
  if (wert.trim() === "") return { betrag: null, fehler: null };
  const betrag = parseEuro(wert);
  if (betrag === null || betrag < 0) return { betrag: null, fehler: amountError("einen Betrag ab 0 €", 500_000, { optional: true }) };
  // Dieselbe Grenze wie die Server-Funktion, damit die Meldung am Feld steht
  if (betrag > MINDESTBESTAND_MAX)
    return { betrag: null, fehler: amountError(`einen Betrag von 0 bis ${formatEuro(MINDESTBESTAND_MAX)}`, 500_000, { optional: true }) };
  return { betrag, fehler: null };
}

function MindestbestandForm({ mindestbestand }: { mindestbestand: Cents | null }) {
  const router = useRouter();
  const save = useServerFn(saveMindestbestand);
  const { busy, notice, run } = useAction();
  const [wert, setWert] = useState(mindestbestand === null ? "" : formatDecimal(mindestbestand));
  const { betrag, fehler } = mindestbestandEingabe(wert);
  const { form, error, check } = useSubmitCheck({ mindestbestand: fehler });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!check()) return;
    await run(
      async () => {
        await save({ data: { mindestbestand: betrag } });
        await router.invalidate();
      },
      betrag === null ? "Mindestbestand entfernt." : "Mindestbestand gespeichert.",
    );
  }

  return (
    <form ref={form} className="stack" style={{ gap: 12 }} onSubmit={(e) => void onSubmit(e)} noValidate>
      <div className="form-row liq-mindestbestand">
        <Field label="Mindestbestand" hint="In Euro; leer heißt keine Warnung" error={error("mindestbestand")}>
          {(control) => <input {...control} name="mindestbestand" inputMode="decimal" className="num" value={wert} onChange={(e) => setWert(e.target.value)} />}
        </Field>
      </div>
      <div className="actions">
        <button type="submit" className="btn" disabled={busy}>
          Speichern
        </button>
      </div>
      <NoticeBanner notice={notice} />
    </form>
  );
}
