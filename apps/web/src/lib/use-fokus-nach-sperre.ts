import { useEffect, useRef } from "react";

/**
 * Ein Feld, das während einer Aktion gesperrt wird (`fieldset disabled`), verliert den Fokus. Bleibt das Formular danach
 * stehen, weil die Aktion fehlschlug, kommt der Fokus wieder dorthin, wo er beim Sperren war (#1148). Baut die Seite das
 * Formular nach Erfolg neu auf, ist das alte Feld weg, und nichts passiert; ebenso, wenn inzwischen etwas anderes den
 * Fokus hat, etwa ein Feld mit Fehler.
 */
export function useFokusNachSperre(gesperrt: boolean) {
  // Laufend mitgeschrieben: Beim Sperren hat der Browser dem Feld den Fokus schon genommen
  const zuletzt = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const merken = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) zuletzt.current = event.target;
    };
    document.addEventListener("focusin", merken);
    return () => document.removeEventListener("focusin", merken);
  }, []);

  const vorher = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (gesperrt) {
      vorher.current = zuletzt.current;
      return;
    }
    const feld = vorher.current;
    vorher.current = null;
    const frei = document.activeElement === null || document.activeElement === document.body;
    if (feld?.isConnected && frei) feld.focus();
  }, [gesperrt]);
}
