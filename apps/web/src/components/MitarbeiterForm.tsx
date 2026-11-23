import { BESCHAEFTIGUNGSARTEN, type Beschaeftigungsart } from "@haben/core";
import { useState, type FormEvent } from "react";
import { useSubmitCheck } from "../lib/use-submit-check.ts";
import { type AbschnittProps, Beschaeftigung, KrankenPflege, Lohnsteuermerkmale, Meldedaten, Person } from "./MitarbeiterAbschnitte.tsx";
import { auswerten, type MitarbeiterWerte, texte } from "./mitarbeiter-pruefung.ts";

/*
 * Stammdaten eines Mitarbeiters für die Lohnabrechnung. Felder, die zur Beschäftigungsart nicht gehören, bleiben ausgeblendet
 * und behalten ihren Wert. Ungültige Angaben meldet useSubmitCheck am Feld (#1277, DESIGN.md, Gesperrte Knöpfe).
 */

/**
 * Arten der Beschäftigung, die es in der Rechtsform gibt: einen Gesellschafter-Geschäftsführer nur in GmbH und UG, im
 * Einzelunternehmen ist der Lohn des Inhabers eine Entnahme. Eine schon gespeicherte Art bleibt wählbar.
 */
export function beschaeftigungsartenFor(gesellschaft: boolean, current?: Beschaeftigungsart): Beschaeftigungsart[] {
  return (Object.keys(BESCHAEFTIGUNGSARTEN) as Beschaeftigungsart[]).filter((art) => art !== "ggf" || gesellschaft || art === current);
}

export function MitarbeiterForm({
  initial,
  arten,
  submitLabel,
  busy,
  onSubmit,
}: {
  initial: MitarbeiterWerte;
  arten: readonly Beschaeftigungsart[];
  submitLabel: string;
  busy: boolean;
  onSubmit: (werte: MitarbeiterWerte) => void;
}) {
  const [w, setW] = useState(initial);
  const [t, setT] = useState(() => texte(initial));
  const { werte, fehler } = auswerten(w, t);
  const pruefung = useSubmitCheck(fehler);
  const abschnitt: AbschnittProps = {
    w,
    set: (key, value) => setW((alt) => ({ ...alt, [key]: value })),
    text: (key) => ({ value: t[key], onChange: (e) => setT((alt) => ({ ...alt, [key]: e.target.value })) }),
    feld: (key) => ({ value: w[key], onChange: (e) => setW((alt) => ({ ...alt, [key]: e.target.value })) }),
    error: pruefung.error,
  };

  function absenden(event: FormEvent) {
    event.preventDefault();
    if (pruefung.check()) onSubmit(werte);
  }

  return (
    <form ref={pruefung.form} noValidate onSubmit={absenden} aria-label="Stammdaten des Mitarbeiters" className="card form-card">
      <Person {...abschnitt} />
      <Beschaeftigung {...abschnitt} arten={arten} />
      <Lohnsteuermerkmale {...abschnitt} />
      <KrankenPflege {...abschnitt} />
      {w.art !== "ggf" && <Meldedaten {...abschnitt} />}
      <div className="actions form-footer">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
