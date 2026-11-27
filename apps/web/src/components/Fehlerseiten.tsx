import { Link } from "@tanstack/react-router";

function Fehlerseite({ titel, text }: { titel: string; text: string }) {
  return (
    <div className="fehlerseite">
      <h1>{titel}</h1>
      <p className="muted">{text}</p>
      <Link to="/" className="btn">
        Zur Übersicht
      </Link>
    </div>
  );
}

export function NichtGefunden() {
  return <Fehlerseite titel="Seite nicht gefunden" text="Diese Adresse gibt es nicht, oder der Datensatz wurde gelöscht." />;
}

/** Ohne die Meldung des Fehlers: Bei einer ungültigen Adresse ist sie nur das JSON der Prüfung */
export function SeitenFehler() {
  return <Fehlerseite titel="Seite konnte nicht geladen werden" text="Die Adresse ist ungültig, oder beim Laden ist ein Fehler aufgetreten." />;
}

/** Ruhige Ladeansicht für den Wechsel auf eine noch nicht geladene Seite; der Text blendet verzögert ein, damit schnelle Wechsel nicht flackern */
export function SeitenLaden() {
  return (
    <div className="seitenladen" role="status" aria-live="polite">
      <p className="muted">Seite wird geladen …</p>
    </div>
  );
}
