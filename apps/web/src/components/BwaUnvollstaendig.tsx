import { unvollstaendigText, type UnvollstaendigHinweis, type Zeitraum } from "@haben/core";
import { Link } from "@tanstack/react-router";
import { siehtSeite } from "../lib/rollen.ts";
import { Icon } from "./Icon.tsx";

const ZIEL = { "/bank": "Zur Bank", "/belege": "Zu den Belegen", "/rechnungen": "Zu den Rechnungen" } as const;

/**
 * Was im Zeitraum der BWA noch fehlt (#1635), wie die Hinweise der Voranmeldung (-zeitraum-hinweise.tsx): Was die Zahlen
 * verfälscht, steht je als eigener Hinweis, was sie nur verfälschen kann, gebündelt in einem. Den Link sieht nur, wer die
 * Seite öffnen darf; die Steuerberatung etwa sieht die Bank nicht.
 */
export function BwaUnvollstaendig({ hinweise, zeitraum, rolle }: { hinweise: readonly UnvollstaendigHinweis[]; zeitraum: Zeitraum; rolle: string }) {
  const inhalt = (h: UnvollstaendigHinweis) => (
    <>
      {unvollstaendigText(h, zeitraum)}
      {siehtSeite(rolle, h.link) && (
        <>
          {" "}
          <Link to={h.link} search={h.konten ? { konto: h.konten.length === 1 ? h.konten[0]!.id : "alle" } : undefined}>
            {ZIEL[h.link]}
          </Link>
        </>
      )}
    </>
  );
    const ruhig = hinweise.filter((h) => h.ton === "info");
  return (
    <>
      {hinweise
        .filter((h) => h.ton === "warn")
        .map((h) => (
          <div key={h.art} className="banner" role="status">
            <Icon name="alert" />
            <span>{inhalt(h)}</span>
          </div>
        ))}
      {ruhig.length > 0 && (
        <div className="banner banner-info" role="status">
          <Icon name="info" />
          {ruhig.length === 1 ? (
            <span>{inhalt(ruhig[0]!)}</span>
          ) : (
            <ul className="banner-list">
              {ruhig.map((h) => (
                <li key={h.art}>{inhalt(h)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
