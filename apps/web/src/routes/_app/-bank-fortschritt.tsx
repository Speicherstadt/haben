import { getRouteApi, Link } from "@tanstack/react-router";
import { type Data, gezeigteKonten, nextOpenAfter, offenText } from "./-bank-daten.ts";

const bankRoute = getRouteApi("/_app/bank");

/** Offene Umsätze der gezeigten Konten, wie am Filter „Offen“; ohne Import gibt es nichts zuzuordnen */
function stand(data: Data) {
  const konten = gezeigteKonten(data);
  return { offen: konten.reduce((summe, konto) => summe + konto.openCount, 0), hatImport: konten.some((konto) => konto.lastImport) };
}

/**
 * Fortschritt über der Umsatzliste (#1253), `sichtbar` die Umsätze der Zeilen (ohne Gebühr einer Zahlung): wie viele Umsätze noch offen sind und „Nächsten offenen“; sind alle zugeordnet,
 * der nächste Schritt. Die Voranmeldung fehlt beim Kleinunternehmer, der keine abgibt.
 */
export function Fortschritt({ data, sichtbar, selectedId }: { data: Data; sichtbar: Data["transactions"]; selectedId: string | undefined }) {
  const search = bankRoute.useSearch();
  const { offen, hatImport } = stand(data);
  if (offen === 0) {
    if (!hatImport) return null;
    return (
      <p className="tx-fortschritt small" role="status">
        <span>
          Alles zugeordnet. Als Nächstes{" "}
          <Link to="/belege" search={{ status: "pruefen" }}>
            Belege prüfen
          </Link>
          {!data.kleinunternehmer && (
            <>
              {" "}
              oder <Link to="/umsatzsteuer">Voranmeldung prüfen</Link>
            </>
          )}
          .
        </span>
      </p>
    );
  }
  // Steht kein weiterer offener Umsatz in der Liste (anderer Filter, Suche), führt der Knopf zum Filter „Offen“, der den ersten wählt
  const naechster = nextOpenAfter(sichtbar, selectedId);
  const imOffenFilter = (search.filter ?? "offen") === "offen";
  return (
    <div className="tx-fortschritt" role="status">
      <span className="small">{offenText(offen)}</span>
      {(naechster || !imOffenFilter) && (
        <Link to="/bank" search={{ ...search, filter: naechster ? search.filter : "offen", umsatz: naechster }} replace className="btn btn-sm">
          Nächsten offenen
        </Link>
      )}
    </div>
  );
}

/** Text der leeren Liste; „Alles zugeordnet.“ steht dann schon im Fortschritt */
export function LeereListe({ data, filter }: { data: Data; filter: string }) {
  const { offen, hatImport } = stand(data);
  if (data.transactions.length > 0 || (filter === "offen" && offen === 0 && hatImport)) return null;
  return (
    <p className="muted" style={{ margin: 0, padding: "16px 20px" }}>
      {filter === "vorschlag" ? "Keine Umsätze mit Vorschlag." : "Keine Umsätze."}
    </p>
  );
}
