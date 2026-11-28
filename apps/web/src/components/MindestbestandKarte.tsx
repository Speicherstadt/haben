import { amountError, formatDecimal, formatEuro, MINDESTBESTAND_MAX, parseEuro, unterschreitung, type Cents, type Vorschau } from "@haben/core";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useState } from "react";
import { formatDate } from "../lib/format.ts";
import { useAction } from "../lib/use-action.ts";
import { useSubmitCheck } from "../lib/use-submit-check.ts";
import { saveMindestbestand } from "../server/functions/liquiditaet.ts";
import { Field } from "./Field.tsx";
import { NoticeBanner } from "./NoticeBanner.tsx";

type Verlauf = Pick<Vorschau, "heute" | "start" | "verlauf">;

/**
 * Mindestbestand der Liquiditätsvorschau (#1381): der Inhaber stellt ihn ein, die Steuerberatung sieht ihn nur. vorschau ist
 * die Vorschau im gewählten Horizont, null ohne bekannten Kontostand.
 */
export function MindestbestandKarte({ mindestbestand, vorschau, aendern }: { mindestbestand: Cents | null; vorschau: Verlauf | null; aendern: boolean }) {
  return (
    <section className="card" aria-labelledby="liq-mindestbestand-titel">
      <h2 id="liq-mindestbestand-titel">Mindestbestand</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Fällt der erwartete Kontostand darunter, warnen ein Hinweis oben auf dieser Seite, die Übersicht und die Fristen-Mail.
      </p>
      {aendern ? (
        <MindestbestandForm mindestbestand={mindestbestand} vorschau={vorschau} />
      ) : (
        <p style={{ margin: 0 }}>{mindestbestand === null ? "Kein Mindestbestand eingestellt." : formatEuro(mindestbestand)}</p>
      )}
    </section>
  );
}

/**
 * Meldung nach dem Speichern mit dem Ergebnis im gewählten Horizont: Der Hinweis dazu steht oben auf der Seite, außer Sicht
 * und ohne Ansage. Ohne bekannten Kontostand (vorschau null) keine Aussage, wie beim Hinweis.
 */
export function speicherMeldung(betrag: Cents | null, vorschau: Verlauf | null): string {
  if (betrag === null) return "Mindestbestand entfernt.";
  if (vorschau === null) return "Mindestbestand gespeichert.";
  const w = unterschreitung(vorschau, betrag);
  return w
    ? `Mindestbestand gespeichert. Der Kontostand unterschreitet ihn am ${formatDate(w.datum)}.`
    : "Mindestbestand gespeichert. Der Kontostand bleibt im gewählten Horizont darüber.";
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

function MindestbestandForm({ mindestbestand, vorschau }: { mindestbestand: Cents | null; vorschau: Verlauf | null }) {
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
      speicherMeldung(betrag, vorschau),
    );
  }

  return (
    <form ref={form} className="stack" style={{ gap: 12 }} onSubmit={(e) => void onSubmit(e)} noValidate>
      <div className="form-row liq-mindestbestand">
        <Field label="Mindestbestand" hint="In Euro; leer heißt keine Warnung, 0 € warnt vor einem Minus" error={error("mindestbestand")}>
          {(control) => <input {...control} name="mindestbestand" inputMode="decimal" className="num" value={wert} onChange={(e) => setWert(e.target.value)} />}
        </Field>
      </div>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Speichern
        </button>
      </div>
      <NoticeBanner notice={notice} />
    </form>
  );
}
