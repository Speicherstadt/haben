import { unvollstaendigText, type UnvollstaendigHinweis } from "@haben/core";
import { Link } from "@tanstack/react-router";
import { siehtSeite } from "../lib/rollen.ts";
import { Icon } from "./Icon.tsx";

const ZIEL = { "/bank": "Zur Bank", "/belege": "Zu den Belegen", "/rechnungen": "Zu den Rechnungen" } as const;

/**
 * Was im Zeitraum der BWA noch fehlt (#1635), wie die Hinweise der Voranmeldung (-zeitraum-hinweise.tsx): Was die Zahlen
 * verfälscht, steht je als eigener Hinweis, was sie nur verfälschen kann, gebündelt in einem. Den Link sieht nur, wer die
 * Seite öffnen darf; die Steuerberatung etwa sieht die Bank nicht.
 */
export function BwaUnvollstaendig({ hinweise, rolle }: { hinweise: readonly UnvollstaendigHinweis[]; rolle: string }) {
  const inhalt = (h: UnvollstaendigHinweis) => (
    <>
      {unvollstaendigText(h)}
      {siehtSeite(rolle, h.link) && (
        <>
          {" "}
          <Link to={h.link} search={h.konto ? { konto: h.konto.id } : undefined}>
            {ZIEL[h.link]}
          </Link>
        </>
      )}
    </>
  );
  const schluessel = (h: UnvollstaendigHinweis) => `${h.art}-${h.konto?.id ?? ""}`;
  const ruhig = hinweise.filter((h) => h.ton === "info");
  return (
    <>
      {hinweise
        .filter((h) => h.ton === "warn")
        .map((h) => (
          <div key={schluessel(h)} className="banner" role="status">
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
                <li key={schluessel(h)}>{inhalt(h)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
