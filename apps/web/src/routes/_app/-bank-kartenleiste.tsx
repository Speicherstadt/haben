import { formatEuro } from "@haben/core";
import { Link } from "@tanstack/react-router";
import { type ReactNode, type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Status } from "../../components/Status.tsx";
import type { Kontokarte } from "../../lib/kontenkarten.ts";
import type { Data } from "./-bank-daten.ts";

/*
 * Kartenleiste der Konten auf der Bankseite (#1951): alle Konten als Karten in einer Zeile, seitlich rollbar, in Gruppen.
 * Unter 1100 px dieselben Konten als schmale Zeile aus Chips, die unter dem Seitenkopf stehen bleibt (bank.css). Beide
 * stehen im Dokument, CSS zeigt eine; die verborgene ist weder per Tab noch für Screenreader erreichbar.
 */

type Filter = "offen" | "zugeordnet" | "alle" | "vorschlag";
type Props = { data: Pick<Data, "karten" | "accountId" | "allAccounts">; filter: Filter };

const GRUPPEN = [
  { gruppe: "banken", titel: "Banken" },
  { gruppe: "zahlungsdienstleister", titel: "Zahlungsdienstleister" },
] as const;

const anzahl = (n: number, eins: string, mehr: string) => `${n} ${n === 1 ? eins : mehr}`;

/** Ob sich die Leiste nach links bzw. rechts rollen lässt; ohne Überlauf beides nicht */
function useRollen(ref: RefObject<HTMLElement | null>) {
  const [stand, setStand] = useState({ links: false, rechts: false });
  const messen = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setStand({ links: el.scrollLeft > 0, rechts: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  }, [ref]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Die gewählte Karte in den sichtbaren Bereich rollen, ohne die Seite zu bewegen
    const aktiv = el.querySelector<HTMLElement>("[aria-current='page']");
    if (aktiv && aktiv.offsetLeft + aktiv.offsetWidth > el.clientWidth) el.scrollLeft = aktiv.offsetLeft - 48;
    messen();
    const beobachter = new ResizeObserver(messen);
    beobachter.observe(el);
    el.addEventListener("scroll", messen, { passive: true });
    return () => {
      beobachter.disconnect();
      el.removeEventListener("scroll", messen);
    };
  }, [ref, messen]);
  const rollen = (richtung: 1 | -1) => ref.current?.scrollBy({ left: richtung * ref.current.clientWidth * 0.8, behavior: "smooth" });
  return { ...stand, rollen };
}

function Gruppe({ titel, children }: { titel: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="konten-gruppe" role="group" aria-labelledby={id}>
      <span id={id} className="konten-gruppe-titel">
        {titel}
      </span>
      <div className="konten-gruppe-karten">{children}</div>
    </div>
  );
}

function KarteStatus({ status, leise }: { status: Kontokarte["status"]; leise: string }) {
  return status ? (
    <Status tone={status.tone} emphasis={status.emphasis} detail={status.detail ?? undefined} inline>
      {status.text}
    </Status>
  ) : (
    <span className="konto-karte-quelle">{leise}</span>
  );
}

function Karte({ name, zahl, offen, status, leise }: { name: string; zahl: string; offen: number; status: Kontokarte["status"]; leise: string }) {
  return (
    <>
      <span className="konto-karte-name">{name}</span>
      <span className="konto-karte-zahlen">
        <span className="amount">{zahl}</span>
        {offen > 0 && <span className="konto-karte-offen">{offen} offen</span>}
      </span>
      <KarteStatus status={status} leise={leise} />
    </>
  );
}

function KartenLeiste({ data, filter }: Props) {
  const ref = useRef<HTMLElement>(null);
  const { links, rechts, rollen } = useRollen(ref);
  const { karten, alle } = data.karten;
  return (
    // Ohne Überlauf bleiben die Pfeile unsichtbar an ihrem Platz, damit die Leiste nicht springt
    <div className="konten-leiste" data-rollbar={links || rechts ? "" : undefined}>
      <button type="button" className="btn btn-ghost btn-icon" aria-label="Konten nach links" onClick={() => rollen(-1)} disabled={!links}>
        <Icon name="chevron-left" />
      </button>
      <nav ref={ref} className="konten-karten" aria-label="Konten">
        {karten.length > 1 && (
          <Gruppe titel="Gesamt">
            <Link to="/bank" search={{ konto: "alle", filter }} aria-current={data.allAccounts ? "page" : undefined} className="konto-karte">
              <Karte
                name="Alle Konten"
                zahl={anzahl(alle.konten, "Konto", "Konten")}
                offen={alle.offen}
                status={alle.mitStatus > 0 ? { text: "Prüfen", tone: "warn", emphasis: "notice", detail: anzahl(alle.mitStatus, "Konto", "Konten") } : null}
                leise="Alles aktuell"
              />
            </Link>
          </Gruppe>
        )}
        {GRUPPEN.map(({ gruppe, titel }) => {
          const inGruppe = karten.filter((k) => k.gruppe === gruppe);
          if (inGruppe.length === 0) return null;
          return (
            <Gruppe key={gruppe} titel={titel}>
              {inGruppe.map((k) => (
                <Link
                  key={k.id}
                  to="/bank"
                  search={{ konto: k.id, filter }}
                  aria-current={k.id === data.accountId ? "page" : undefined}
                  className="konto-karte"
                >
                  <Karte name={k.name} zahl={k.saldo === null ? "–" : formatEuro(k.saldo)} offen={k.offen} status={k.status} leise={k.quelle} />
                </Link>
              ))}
            </Gruppe>
          );
        })}
      </nav>
      <button type="button" className="btn btn-ghost btn-icon" aria-label="Konten nach rechts" onClick={() => rollen(1)} disabled={!rechts}>
        <Icon name="chevron-right" />
      </button>
    </div>
  );
}

function Chip({
  to,
  aktiv,
  name,
  offen,
  status,
}: {
  to: { konto: string; filter: Filter };
  aktiv: boolean;
  name: string;
  offen: number;
  status?: Kontokarte["status"];
}) {
  return (
    <Link to="/bank" search={to} aria-current={aktiv ? "page" : undefined} className="konto-chip" data-tone={status?.tone}>
      {status !== undefined && <span className="konto-chip-punkt" aria-hidden="true" />}
      <span className="konto-chip-name">{name}</span>
      {status && <span className="visually-hidden">, {status.text}</span>}
      {offen > 0 && (
        <span className="konto-chip-zahl">
          {offen}
          <span className="visually-hidden"> offen</span>
        </span>
      )}
    </Link>
  );
}

/** Schmale Zeile: Punkt in der Farbe des Status, Name und Zahl offener Umsätze (fehlt bei null); das Wort des Status liest der Screenreader */
function KontenChips({ data, filter }: Props) {
  const { karten, alle } = data.karten;
  return (
    <nav className="konten-chips" aria-label="Konten">
      {karten.length > 1 && <Chip to={{ konto: "alle", filter }} aktiv={data.allAccounts} name="Alle" offen={alle.offen} />}
      {GRUPPEN.map(({ gruppe }, i) => {
        const inGruppe = karten.filter((k) => k.gruppe === gruppe);
        if (inGruppe.length === 0) return null;
        return [
          (karten.length > 1 || (i > 0 && karten.some((k) => k.gruppe === "banken"))) && (
            <span key={`trenner-${gruppe}`} className="konten-chips-trenner" aria-hidden="true" />
          ),
          ...inGruppe.map((k) => (
            <Chip key={k.id} to={{ konto: k.id, filter }} aktiv={k.id === data.accountId} name={k.name} offen={k.offen} status={k.status} />
          )),
        ];
      })}
    </nav>
  );
}

export function Kartenleiste(props: Props) {
  return (
    <>
      <KartenLeiste {...props} />
      <KontenChips {...props} />
    </>
  );
}
