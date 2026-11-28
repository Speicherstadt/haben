import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { readForeignInvoice } from "../server/functions/fremdrechnung.ts";
import { discardInboxOutgoing, getInboxOutgoing } from "../server/functions/inbox.ts";
import type { Read } from "./ForeignInvoiceImport.tsx";
import { dateiOf } from "./postfach-ausgang-helfer.ts";

export type Eintrag = Awaited<ReturnType<typeof getInboxOutgoing>>[number];

/** Das offene Formular zum Übernehmen: die Datei, was Haben daraus liest und welcher Eintrag im Postfach dazugehört */
type Offen = { file: File; data: Read; postfach: string };

const meldung = (e: unknown, sonst: string) => (e instanceof Error ? e.message : sonst);

/**
 * Zustand und Aktionen der Karte „Aus dem Postfach“: Liste laden, Auswahl, Formular zum Übernehmen (einzeln oder als
 * Reihe), PDF ansehen, Verwerfen.
 */
export function usePostfachAusgang() {
  const router = useRouter();
  const [liste, setListe] = useState<Eintrag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gewaehlt, setGewaehlt] = useState<Set<string>>(new Set());
  const [offen, setOffen] = useState<Offen | null>(null);
  /** Was nach der Rechnung im Formular noch folgt; null: eine einzelne Rechnung, danach geht es zu ihr */
  const [danach, setDanach] = useState<string[] | null>(null);
  const [verwerfen, setVerwerfen] = useState<string[] | null>(null);

  async function laden() {
    try {
      const neu = await getInboxOutgoing();
      setListe(neu);
      setGewaehlt((alt) => new Set([...alt].filter((id) => neu.some((e) => e.id === id))));
    } catch (e) {
      setError(meldung(e, "Die Ausgangsrechnungen aus dem Postfach lassen sich nicht laden."));
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: einmal beim Öffnen der Seite laden
  useEffect(() => {
    void laden();
  }, []);

  async function oeffnen(ids: string[]) {
    const [id, ...rest] = ids;
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      const file = await dateiOf(id);
      const form = new FormData();
      form.set("file", file);
      setOffen({ file, data: await readForeignInvoice({ data: form }), postfach: id });
      setDanach(ids.length > 1 ? rest : null);
    } catch (e) {
      setError(meldung(e, "Die Datei lässt sich nicht lesen."));
      // In einer Reihe steht noch das erledigte Formular da und verdeckt die Meldung
      schliessen();
    } finally {
      setBusy(false);
    }
  }

  async function ansehen(id: string) {
    setError(null);
    try {
      const url = URL.createObjectURL(await dateiOf(id));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(meldung(e, "Die Datei lässt sich nicht öffnen."));
    }
  }

  async function verwerfenBestaetigt(ids: string[]) {
    setBusy(true);
    setError(null);
    try {
      for (const id of ids) await discardInboxOutgoing({ data: { id } });
    } catch (e) {
      setError(meldung(e, "Die Datei lässt sich nicht verwerfen."));
    } finally {
      setBusy(false);
      await laden();
    }
  }

  /** Nach einer übernommenen Rechnung der Reihe: die nächste öffnen, nach der letzten die Liste neu laden */
  function weiter() {
    if (!danach || danach.length === 0) return schliessen();
    void router.invalidate();
    void oeffnen(danach);
  }

  function schliessen() {
    setOffen(null);
    setDanach(null);
    void laden();
    // In einer Reihe sind schon Rechnungen dazugekommen
    void router.invalidate();
  }

  const umschalten = (id: string) =>
    setGewaehlt((alt) => {
      const neu = new Set(alt);
      if (!neu.delete(id)) neu.add(id);
      return neu;
    });

  return {
    liste,
    error,
    busy,
    gewaehlt,
    setGewaehlt,
    umschalten,
    offen,
    /** Nur in einer Reihe bleibt das Formular nach dem Übernehmen auf der Seite */
    inReihe: danach !== null,
    verwerfen,
    setVerwerfen,
    oeffnen,
    ansehen,
    verwerfenBestaetigt,
    weiter,
    schliessen,
  };
}
