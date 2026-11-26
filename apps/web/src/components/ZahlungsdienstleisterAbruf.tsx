import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useId, useState } from "react";
import { formatDate, formatDateTime } from "../lib/format.ts";
import { useAction } from "../lib/use-action.ts";
import { zugangGueltigBisText } from "../lib/zahlungsdienstleister-text.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { KonfliktKlaeren } from "./ImportKonflikt.tsx";
import { quelleZuAnbieter } from "../lib/import-quelle.ts";
import { NoticeBanner } from "./NoticeBanner.tsx";
import { type PspDaten, type PspVerbindung, VerbindungFormular } from "./ZahlungsdienstleisterFormular.tsx";
import { removePspConnectionFn, syncPspNow } from "../server/functions/zahlungsdienstleister.ts";

/*
 * Verbindung zu einem Zahlungsdienstleister über seine API (#1729) auf der Bankseite über der Liste ihres Kontos (#1951):
 * Stand, Fehler, Konflikte, „Jetzt abrufen“, „Bearbeiten“ und „Entfernen“. Neu verbunden wird über die geführte
 * Einrichtung (routes/_app/bank_.verbinden.$anbieter.tsx).
 */

const SPALTE = { display: "flex", flexDirection: "column", gap: 8 } as const;

/**
 * Eine Verbindung: Stand, Meldungen, Konflikte und Aktionen; „Bearbeiten“ öffnet das Formular an ihrer Stelle. Die
 * Meldung nach dem Entfernen zeigt, wer entfernen übergibt: Die Zeile ist danach weg.
 */
export function VerbindungZeile({
  daten,
  verbindung: v,
  entfernen,
}: {
  daten: PspDaten;
  verbindung: PspVerbindung;
  entfernen: ReturnType<typeof useAction>["run"];
}) {
  const router = useRouter();
  const remove = useServerFn(removePspConnectionFn);
  const sync = useServerFn(syncPspNow);
  const [bearbeiten, setBearbeiten] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [geklaert, setGeklaert] = useState(false);
  const { busy, notice, setNotice, run } = useAction();
  const headingId = useId();
  const anbieter = daten.anbieter.find((a) => a.provider === v.provider);
  return (
    <section aria-labelledby={headingId} style={SPALTE}>
      <h3 id={headingId} style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
        {v.name}
      </h3>
      <p className="small" style={{ margin: "0.25rem 0 0" }}>
        <strong>
          {anbieter?.name ?? v.provider}: verbunden mit {v.accountId} ({anbieter?.zugangName ?? "Zugang"} …{v.keyHint}).
        </strong>{" "}
        {v.kontoName ? `Konto in Haben: ${v.kontoName}. ` : "Noch kein Konto in Haben. "}
        {v.lastSyncAt ? `Letzter Abruf: ${formatDateTime(v.lastSyncAt)}.` : "Noch kein Abruf."}
        {v.lastSyncAt ? ` Der nächste Abruf holt ab dem ${formatDate(v.naechsterAbrufAb)}.` : ""}
        {v.zugangGueltigBis ? zugangGueltigBisText(v.zugangGueltigBis) : ""}
      </p>
      {v.hinweis && (
        <div className="banner banner-warn" role="note">
          {v.hinweis}
        </div>
      )}
      {v.lastError && (
        <div className="banner banner-danger" role="status">
          {v.lastError}
        </div>
      )}
      {(v.konflikte.length > 0 || geklaert) && (
        <div className="actions">
          <KonfliktKlaeren konflikte={v.konflikte} disabled={busy} quelle={quelleZuAnbieter(v.provider)} onGeklaert={() => setGeklaert(true)} />
        </div>
      )}
      {bearbeiten ? (
        <VerbindungFormular
          daten={daten}
          verbindung={v}
          onFertig={(gespeichert) => {
            setBearbeiten(false);
            if (gespeichert) setNotice({ tone: "ok", text: "Verbindung gespeichert." });
          }}
        />
      ) : (
        <div className="actions">
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setConfirmingRemove(true)}>
            Verbindung entfernen
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => setBearbeiten(true)}>
            Bearbeiten
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setGeklaert(false);
                const result = await sync({ data: { id: v.id } });
                await router.invalidate();
                if (result.error) throw new Error(result.error);
                return result;
              }, "Abruf durchgelaufen.")
            }
          >
            {busy ? "Laufe …" : "Jetzt abrufen"}
          </button>
        </div>
      )}
      <NoticeBanner notice={notice} />
      <ConfirmDialog
        open={confirmingRemove}
        title={`Verbindung ${v.name} entfernen?`}
        confirmLabel="Entfernen"
        danger
        onConfirm={() => {
          setConfirmingRemove(false);
          void entfernen(async () => {
            await remove({ data: { id: v.id } });
            await router.invalidate();
          }, "Verbindung entfernt. Übernommene Umsätze bleiben im Konto stehen.");
        }}
        onClose={() => setConfirmingRemove(false)}
      >
        <p>
          Der Zugang wird gelöscht. Bereits übernommene Umsätze bleiben im Konto des Zahlungsdienstleisters stehen; ein neuer Abruf legt sie nicht noch einmal
          an.
        </p>
      </ConfirmDialog>
    </section>
  );
}
