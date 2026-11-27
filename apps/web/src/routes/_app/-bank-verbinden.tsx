import { PAYMENT_PROVIDERS } from "@haben/core";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { FINTS_ANLEITUNG, type FintsZustand, wartetAuf } from "../../components/FintsAbruf.tsx";
import { FormDialog } from "../../components/FormDialog.tsx";
import { MoreActionsMenu } from "../../components/MoreActionsMenu.tsx";
import { kontenText, verbundenText, zugangArt } from "../../lib/psp-einrichtung.ts";
import { wegText, wegeVon } from "../../lib/psp-wege.ts";
import type { Data } from "./-bank-daten.ts";

/*
 * „Konto verbinden ▾“ im Kopf der Bankseite (#1951): ein Menü für Bank, Zahlungsdienstleister und ein Konto ohne Abruf.
 * „Bank hinzufügen“ fragt im Dialog, wie (Enable Banking, FinTS oder Datei), „Zahlungsdienstleister hinzufügen“ nach dem
 * Anbieter und führt dann zur Einrichtung in Schritten, für jeden Anbieter (#2008). Was auf dieser Installation nicht geht,
 * steht ausgegraut mit Grund.
 */

export type BankWeg = "enablebanking" | "fints" | "datei";
export type VerbindenDialog = "bank" | "anbieter" | null;

/** Eine Wahl im Dialog: Name, wann sie passt, und, wenn sie gerade nicht geht, warum (mit Link, wo es sich beheben lässt) */
type Wahl<T extends string> = { wert: T; label: string; hint: string; gesperrt: ReactNode | null };

const EINSTELLUNGEN_BANK = (
  <Link to="/einstellungen" search={{ bereich: "bank" }}>
    Einstellungen › Bank
  </Link>
);

/** Die drei Wege zur Bank; FinTS wartet wie bisher auf einen offenen Schritt oder Abruf an einer Zeile (#1647, #1660) */
export function bankWege(data: Pick<Data, "sync" | "fints">, fintsZustand: Pick<FintsZustand, "offen" | "busy">): Wahl<BankWeg>[] {
  const sobald = wartetAuf(data.fints.connections, fintsZustand);
  return [
    {
      wert: "enablebanking",
      label: "Online-Banking über Enable Banking (PSD2)",
      hint: "Für die meisten Banken in Europa: Du gibst den Lesezugriff bei deiner Bank frei, Haben holt die Umsätze täglich.",
      gesperrt: data.sync.configured ? null : <>Braucht einen Zugang zu Enable Banking; einrichten unter {EINSTELLUNGEN_BANK}.</>,
    },
    {
      wert: "fints",
      label: "FinTS (PIN/TAN)",
      hint: "Vor allem für Sparkassen, Volks- und Raiffeisenbanken: Haben meldet sich mit Anmeldename und PIN an.",
      gesperrt: !data.fints.configured ? (
        <>
          Braucht die Produktnummer der Installation (FINTS_PRODUKT_ID);{" "}
          <a href={FINTS_ANLEITUNG} target="_blank" rel="noreferrer">
            Anleitung
          </a>
          .
        </>
      ) : sobald ? (
        `„Über FinTS verbinden“ geht wieder, sobald ${sobald}.`
      ) : null,
    },
    {
      wert: "datei",
      label: "Kontoauszüge als Datei (CSV/CAMT)",
      hint: "Geht immer: Du exportierst die Umsätze bei deiner Bank und importierst die Datei.",
      gesperrt: null,
    },
  ];
}

/**
 * Alle Zahlungsdienstleister (#2008), die mit Abruf über die API zuerst; unter jedem sein Weg (API, Datei, unter
 * Verbindungen, nur Konto) und die Konten bzw. Verbindungen, die es schon gibt
 */
export function anbieterWahl(daten: Pick<Data["zahlungsdienstleister"], "anbieter" | "verbindungen" | "alleKonten">): Wahl<string>[] {
  const mitAdapter = (p: string) => daten.anbieter.some((a) => a.provider === p);
  const reihenfolge = [...daten.anbieter.map((a) => a.provider), ...Object.keys(PAYMENT_PROVIDERS).filter((p) => !mitAdapter(p))];
  return reihenfolge.map((provider) => {
    const adapter = daten.anbieter.find((a) => a.provider === provider);
    const label = adapter?.name ?? PAYMENT_PROVIDERS[provider as keyof typeof PAYMENT_PROVIDERS].label;
    const verbindungen = daten.verbindungen.filter((v) => v.provider === provider);
    const gebunden = new Set(verbindungen.map((v) => v.bankAccountId));
    // Konten, an denen keine Verbindung hängt (aus Dateien oder ohne Import), heißen nicht „verbunden“
    const konten = daten.alleKonten.filter((k) => k.provider === provider && !gebunden.has(k.id)).map((k) => k.name);
    const weg = wegText(provider, wegeVon(provider, adapter !== undefined), adapter ? zugangArt(adapter.felder) : null);
    const bestehend = adapter
      ? [verbundenText(verbindungen.map((v) => v.name)), ...(konten.length > 0 ? [kontenText(konten)] : [])].join(" · ")
      : kontenText(konten);
    return { wert: provider, label, hint: `${weg} · ${bestehend}`, gesperrt: null };
  });
}

/** Optionsfelder mit Hinweis und Grund darunter; ein gesperrter Weg zeigt per aria-describedby auf seinen Grund */
function Auswahl<T extends string>({ legend, wahlen, wert, setWert }: { legend: string; wahlen: Wahl<T>[]; wert: T | null; setWert: (w: T) => void }) {
  const id = useId();
  return (
    <fieldset className="choice-group verbinden-wahl">
      <legend>{legend}</legend>
      {wahlen.map((w) => {
        const beschreibung = [w.hint && `${id}-${w.wert}-hint`, w.gesperrt && `${id}-${w.wert}-grund`].filter(Boolean).join(" ");
        return (
          <div key={w.wert} className="checkbox-hinted" data-gesperrt={w.gesperrt ? "" : undefined}>
            <label className="checkbox">
              <input
                type="radio"
                name={id}
                value={w.wert}
                checked={wert === w.wert}
                disabled={w.gesperrt !== null}
                onChange={() => setWert(w.wert)}
                aria-describedby={beschreibung || undefined}
              />
              <span>{w.label}</span>
            </label>
            {w.hint && (
              <span id={`${id}-${w.wert}-hint`} className="field-hint">
                {w.hint}
              </span>
            )}
            {w.gesperrt && (
              <span id={`${id}-${w.wert}-grund`} className="field-hint">
                {w.gesperrt}
              </span>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

/** Dialog mit einer Auswahl und „Weiter“; vorgewählt ist die erste Wahl, die geht */
function WahlDialog<T extends string>({
  titel,
  legend,
  wahlen,
  onWeiter,
  onClose,
}: {
  titel: string;
  legend: string;
  wahlen: Wahl<T>[];
  onWeiter: (wert: T) => void;
  onClose: () => void;
}) {
  const [wert, setWert] = useState<T | null>(wahlen.find((w) => !w.gesperrt)?.wert ?? null);
  // Wird die Wahl gesperrt, während der Dialog offen ist (etwa ein Schritt der Bank an einer Zeile), gilt sie nicht mehr
  const gewaehlt = wahlen.find((w) => w.wert === wert && !w.gesperrt)?.wert ?? null;
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!gewaehlt) return;
    onClose();
    onWeiter(gewaehlt);
  }
  return (
    <FormDialog open title={titel} onClose={onClose}>
      <form onSubmit={onSubmit}>
        <Auswahl legend={legend} wahlen={wahlen} wert={gewaehlt} setWert={setWert} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="btn btn-primary">
            Weiter
          </button>
        </div>
      </form>
    </FormDialog>
  );
}

/** Menüknopf „Konto verbinden“ mit den Dialogen „Wie verbinden?“ und „Anbieter wählen“ */
export function KontoVerbinden({
  data,
  fintsZustand,
  onBankWeg,
  onOhneAbruf,
  primary = false,
  dialog: gesteuert,
  setDialog: setGesteuert,
}: {
  data: Pick<Data, "sync" | "fints" | "zahlungsdienstleister">;
  fintsZustand: Pick<FintsZustand, "offen" | "busy">;
  onBankWeg: (weg: BankWeg) => void;
  onOhneAbruf: () => void;
  primary?: boolean;
  /** Offener Dialog, wenn die Seite ihn auch von anderswo öffnet („Bank hinzufügen“ im Kopf einer Gruppe) */
  dialog?: VerbindenDialog;
  setDialog?: (d: VerbindenDialog) => void;
}) {
  const navigate = useNavigate();
  const [eigener, setEigener] = useState<VerbindenDialog>(null);
  const dialog = setGesteuert ? (gesteuert ?? null) : eigener;
  const setDialog = setGesteuert ?? setEigener;
  return (
    <>
      <MoreActionsMenu
        text="Konto verbinden"
        primary={primary}
        items={[
          { key: "bank", label: "Bank hinzufügen", onSelect: () => setDialog("bank") },
          { key: "anbieter", label: "Zahlungsdienstleister hinzufügen", onSelect: () => setDialog("anbieter") },
          { key: "ohne", label: "Konto ohne Abruf anlegen", onSelect: onOhneAbruf },
        ]}
      />
      {dialog === "bank" && (
        <WahlDialog titel="Wie verbinden?" legend="Weg zur Bank" wahlen={bankWege(data, fintsZustand)} onWeiter={onBankWeg} onClose={() => setDialog(null)} />
      )}
      {dialog === "anbieter" && (
        <WahlDialog
          titel="Zahlungsdienstleister hinzufügen"
          legend="Anbieter"
          wahlen={anbieterWahl(data.zahlungsdienstleister)}
          onWeiter={(anbieter) => void navigate({ to: "/bank/verbinden/$anbieter", params: { anbieter } })}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
