/** Die zwei Wege, eine festgeschriebene Rechnung zu ändern: Storno und Rechnungskorrektur */
export function KorrekturAktionen({ busy, onCancel, onCorrect }: { busy: boolean; onCancel: () => void; onCorrect: () => void }) {
  return (
    <div className="actions">
      <button type="button" className="btn btn-danger" onClick={onCancel} disabled={busy}>
        Stornieren
      </button>
      <button type="button" className="btn" onClick={onCorrect} disabled={busy}>
        Rechnungskorrektur anlegen
      </button>
    </div>
  );
}
