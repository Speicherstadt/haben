import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { ErrorBanner } from "./ErrorBanner.tsx";
import { ForeignInvoiceImport } from "./ForeignInvoiceImport.tsx";
import { PostfachAusgangTabelle } from "./PostfachAusgangTabelle.tsx";
import { usePostfachAusgang } from "./use-postfach-ausgang.ts";

/**
 * Ausgangsrechnungen, die der Abruf aus dem Ordner für Ausgangsrechnungen des Postfachs geholt hat (#660). Gebucht ist noch
 * nichts: „Übernehmen“ öffnet dasselbe Formular wie „Ausgangsrechnung hochladen“, mit dem PDF aus dem Postfach. Mit
 * „Alle übernehmen“ (oder der Auswahl) folgen die Formulare nacheinander.
 */
export function PostfachAusgang() {
  const p = usePostfachAusgang();
  if (p.offen) {
    return <ForeignInvoiceImport key={p.offen.postfach} vorgabe={p.offen} onAdopted={p.inReihe ? p.weiter : undefined} onClose={p.schliessen} />;
  }
  if (p.liste.length === 0 && !p.error) return null;

  const alle = p.liste.length > 0 && p.gewaehlt.size === p.liste.length;
  const ziele = p.gewaehlt.size > 0 ? p.liste.filter((e) => p.gewaehlt.has(e.id)).map((e) => e.id) : p.liste.map((e) => e.id);
  const loeschen = p.verwerfen;
  return (
    <section className="card postfach-ausgang" aria-labelledby="postfach-ausgang-heading" style={{ marginBottom: 16 }}>
      <div className="actions" style={{ alignItems: "center", marginBottom: 8 }}>
        <h2 id="postfach-ausgang-heading" style={{ margin: 0 }}>
          Aus dem Postfach
        </h2>
        <span className="small muted">{p.liste.length} offen</span>
        <span style={{ flex: 1 }} />
        {p.gewaehlt.size > 0 && (
          <button type="button" className="btn" disabled={p.busy} onClick={() => p.setVerwerfen([...p.gewaehlt])}>
            Auswahl verwerfen
          </button>
        )}
        <button type="button" className="btn btn-primary" disabled={p.busy || ziele.length === 0} onClick={() => void p.oeffnen(ziele)}>
          {p.gewaehlt.size > 0 ? `${p.gewaehlt.size} übernehmen` : "Alle übernehmen"}
        </button>
      </div>
      {p.error && <ErrorBanner title="Postfach" detail={p.error} />}
      <PostfachAusgangTabelle
        liste={p.liste}
        gewaehlt={p.gewaehlt}
        busy={p.busy}
        onAlle={() => p.setGewaehlt(alle ? new Set() : new Set(p.liste.map((e) => e.id)))}
        onUmschalten={p.umschalten}
        onUebernehmen={(id) => void p.oeffnen([id])}
        onAnsehen={(id) => void p.ansehen(id)}
        onVerwerfen={(id) => p.setVerwerfen([id])}
      />
      <ConfirmDialog
        open={loeschen !== null}
        title={loeschen && loeschen.length > 1 ? `${loeschen.length} Ausgangsrechnungen verwerfen?` : "Ausgangsrechnung verwerfen?"}
        confirmLabel="Verwerfen"
        danger
        onConfirm={() => {
          p.setVerwerfen(null);
          void p.verwerfenBestaetigt(loeschen ?? []);
        }}
        onClose={() => p.setVerwerfen(null)}
      >
        <p>
          Die Datei wird nicht übernommen und vom Abruf nicht wieder angeboten. Am Postfach ändert das Verwerfen nichts; eine dort schon gelöschte Mail kommt
          nicht zurück.
        </p>
      </ConfirmDialog>
    </section>
  );
}
