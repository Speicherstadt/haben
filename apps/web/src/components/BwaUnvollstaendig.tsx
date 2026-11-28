import { unvollstaendigText, type UnvollstaendigHinweis, type Zeitraum } from "@haben/core";
import { Link } from "@tanstack/react-router";
import { siehtSeite } from "../lib/rollen.ts";
import { Icon } from "./Icon.tsx";

const ZIEL = { "/bank": "Zur Bank", "/belege": "Zu den Belegen", "/rechnungen": "Zu den Rechnungen" } as const;

export type Ziel =
  | { to: "/bank"; search: { konto: string } }
  | { to: "/belege"; search: { status: "pruefen" } }
  | { to: "/rechnungen"; search: undefined };

/**
 * Wohin der Link eines Hinweises führt: offene Umsätze zählen über alle Konten, also zu allen (ohne `konto` zeigte die Bank nur
 * das erste); ein Konto, das zu früh aufhört, zu ihm; Belege zu denen „Zu prüfen“.
 */
export function ziel(h: UnvollstaendigHinweis): Ziel {
  switch (h.link) {
    case "/bank":
      return { to: "/bank", search: { konto: h.konten?.length === 1 ? h.konten[0]!.id : "alle" } };
    case "/belege":
      return { to: "/belege", search: { status: "pruefen" } };
    case "/rechnungen":
      return { to: "/rechnungen", search: undefined };
  }
}

/**
 * Was im Zeitraum der BWA noch fehlt (#1635), wie die Hinweise der Voranmeldung (-zeitraum-hinweise.tsx): Was die Zahlen
 * verfälscht, steht je als eigener Hinweis, was sie nur verfälschen kann, gebündelt in einem. Den Link sieht nur, wer die
 * Seite öffnen darf; die Steuerberatung etwa sieht die Bank nicht.
 */
export function BwaUnvollstaendig({ hinweise, zeitraum, rolle }: { hinweise: readonly UnvollstaendigHinweis[]; zeitraum: Zeitraum; rolle: string }) {
  const inhalt = (h: UnvollstaendigHinweis, z: Ziel | null) => (
    <>
      {unvollstaendigText(h, zeitraum)}
      {z && siehtSeite(rolle, z.to) && (
        <>
          {" "}
          <Link to={z.to} search={z.search}>
            {ZIEL[z.to]}
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
            <span>{inhalt(h, ziel(h))}</span>
          </div>
        ))}
      {ruhig.length > 0 && (
        <div className="banner banner-info" role="status">
          <Icon name="info" />
          {ruhig.length === 1 ? (
            <span>{inhalt(ruhig[0]!, ziel(ruhig[0]!))}</span>
          ) : (
            <ul className="banner-list">
              {ruhig.map((h) => (
                <li key={h.art}>{inhalt(h, ziel(h))}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
