import { computeUstva, formatDecimal, formatEuro, parseEuro, parsePeriodKey, periodKey, periodLabel, quarterOfMonth } from "@haben/core";
import { Link, createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "../../../components/Icon.tsx";
import { EricHinweis } from "../../../components/EricHinweis.tsx";
import { NoticeBanner } from "../../../components/NoticeBanner.tsx";
import { VatFrequencyCard } from "../../../components/umsatzsteuer/VatFrequencyCard.tsx";
import { DauerfristCard } from "../../../components/umsatzsteuer/DauerfristCard.tsx";
import { VatStatus } from "../../../components/umsatzsteuer/VatStatus.tsx";
import { JournalVergleich } from "../../../components/umsatzsteuer/JournalVergleich.tsx";
import { formatLongDate } from "../../../lib/format.ts";
import { getVatPeriod } from "../../../server/functions/vat.ts";
import type { Notice } from "../../../lib/use-action.ts";
import { usePruefungBeimSpeichern } from "./-zeitraum-pruefung.ts";
import { Field } from "../../../components/Field.tsx";
import type { PageData } from "./-zeitraum-quellen.tsx";
import { type FieldKey, KennzahlenTabelle } from "./-zeitraum-kennzahlen.tsx";
import { AbgabeSpalte, anmeldbar, useVoranmeldungAktionen } from "./-zeitraum-abgabe.tsx";

export const Route = createFileRoute("/_app/umsatzsteuer/$zeitraum")({
  loader: ({ params }) => {
    const period = parsePeriodKey(params.zeitraum);
    if (!period) throw notFound();
    return getVatPeriod({ data: period });
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `Umsatzsteuer ${loaderData ? periodLabel(loaderData.period) : ""} · Haben` }],
  }),
  component: VatPeriodPage,
});

const ELSTER_ABGABE_DOCS = "https://haben.app/elster-abgabe.html";

const FIELDS: FieldKey[] = [
  "kz81",
  "kz86",
  "kz21",
  "kz39",
  "kz41",
  "kz43",
  "kz45",
  "kz46",
  "kz47",
  "kz48",
  "kz50",
  "kz61",
  "kz62",
  "kz66",
  "kz67",
  "kz84",
  "kz85",
  "kz89",
  "kz93",
];

type Figures = Pick<Record<FieldKey, number>, "kz81" | "kz86" | "kz66"> & Partial<Record<FieldKey, number>>;

/**
 * Kennzahlen für den Vergleich mit einer gesendeten Anmeldung: ohne Kz 50 wie der Abgleich in gesendet-pruefen.ts (#1267).
 * Sie ändert keine Steuer, und vor #1267 gesendete Anmeldungen haben sie nicht.
 */
const GESENDET_VERGLEICHEN = FIELDS.filter((field) => field !== "kz50");

/** Gleiche Kennzahlen? Fehlende Kz 21/45/48 (ältere Anmeldungen) zählen als 0 */
function sameFigures(a: Figures, b: Figures, fields: readonly FieldKey[] = FIELDS): boolean {
  return fields.every((field) => (a[field] ?? 0) === (b[field] ?? 0));
}

/**
 * Weicht die heutige Rechnung von der gesendeten Anmeldung ab? Kz 48 gilt auch ohne die Umsätze als Kleinunternehmer als
 * gleich, so hat Haben sie vor #1268 gemeldet (wie gesendet-pruefen.ts)
 */
function seitGesendetGeaendert(gesendet: Figures, computed: Figures, data: PageData): boolean {
  const vor1268 = computeUstva({ ...data.figures, kz48: data.figures.kz48 - data.figures.kz48Kleinunternehmer, kz39: data.kz39 });
  return !sameFigures(gesendet, computed, GESENDET_VERGLEICHEN) && !sameFigures(gesendet, vor1268, GESENDET_VERGLEICHEN);
}
type PeriodNotice = { key: string; notice: Notice };

/** „Kz 81 1.000,00 €, Kz 86 0,00 € und Kz 66 12,00 €“; Kz 21/45/48 nur, wenn belegt */
function describe(figures: Record<FieldKey, number>): string {
  const parts = FIELDS.filter((f) => ["kz81", "kz86", "kz66"].includes(f) || figures[f] !== 0).map((f) => `Kz ${f.slice(2)} ${formatEuro(figures[f])}`);
  return `${parts.slice(0, -1).join(", ")} und ${parts.at(-1)}`;
}

function VatPeriodPage() {
  const data = Route.useLoaderData();
  const navigate = useNavigate();
  const key = periodKey(data.period);
  // Meldungen überleben das Neuaufsetzen des Formulars nach dem Speichern
  // und gelten nur für den Zeitraum, in dem sie entstanden sind.
  const [periodNotice, setPeriodNotice] = useState<PeriodNotice | null>(null);
  const notice = periodNotice?.key === key ? periodNotice.notice : null;
  const setNotice = (next: Notice) => setPeriodNotice({ key, notice: next });
  // Zeiträume nach dem eingestellten Voranmeldungszeitraum, dazu der angezeigte, falls er nicht dazugehört
  const options = [...data.periods];
  if (!options.some((option) => periodKey(option) === key)) options.push(data.period);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Umsatzsteuer › Voranmeldung</div>
          <div className="title-with-status">
            <h1>{periodLabel(data.period)}</h1>
            <VatStatus current={data.current} filedOn={data.filings.find((f) => f.vatReturnId === data.current?.id)?.filedOn ?? null} dueDate={data.dueDate} />
          </div>
        </div>
        <Field label="Zeitraum">
          {(control) => (
            <select {...control} value={key} onChange={(event) => navigate({ to: "/umsatzsteuer/$zeitraum", params: { zeitraum: event.target.value } })}>
              {options.map((option) => (
                <option key={periodKey(option)} value={periodKey(option)}>
                  {periodLabel(option)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      {data.mode === "simuliert" && <EricHinweis />}
      {!data.herstellerIdConfigured && data.current?.status !== "sent" && (
        <div className="banner banner-info" role="status">
          <Icon name="info" />
          <span>
            Ohne eigene Hersteller-ID gibst du in Mein ELSTER ab: Entwurf speichern, „XML für Mein ELSTER“ herunterladen und dort im Formular
            Umsatzsteuer-Voranmeldung unter Datenübernahme › XML-Import hochladen. Prüfen und absenden machst du in Mein ELSTER.{" "}
            <a href={ELSTER_ABGABE_DOCS} target="_blank" rel="noreferrer">
              Abgabe in Mein ELSTER
            </a>
          </span>
        </div>
      )}
      {data.periodProblem && (
        <div className="banner" role="status">
          <Icon name="alert" />
          <span>{data.periodProblem}</span>
        </div>
      )}
      {data.companyIssues.length > 0 && (
        <div className="banner" role="status">
          <Icon name="alert" />
          <span>
            Firmendaten unvollständig: {data.companyIssues.join(", ")}.{" "}
            <Link to="/einstellungen" search={{ bereich: "firma" }}>
              In den Einstellungen ergänzen
            </Link>
          </span>
        </div>
      )}

      {data.current?.status !== "sent" &&
        data.preflight.map((issue) => (
          <div key={issue.text} className={`banner ${issue.tone === "info" ? "banner-info" : ""}`} role="status">
            <Icon name={issue.tone === "info" ? "info" : "alert"} />
            <span>
              {issue.text}{" "}
              <Link to={issue.link}>
                {
                  {
                    "/bank": "Zur Bank",
                    "/belege": "Zu den Belegen",
                    "/rechnungen": "Zu den Rechnungen",
                    "/konten": "Zu den Konten",
                  }[issue.link]
                }
              </Link>
            </span>
          </div>
        ))}

      {(data.figures.kz21 !== 0 || data.figures.kz41 !== 0) && (
        <div className="banner banner-info" role="status">
          <Icon name="info" />
          <span>
            {data.figures.kz41 !== 0 ? "Leistungen und Lieferungen ins EU-Ausland (Kz 21, 41)" : "Leistungen ins EU-Ausland (Kz 21)"} meldest du je Quartal
            zusätzlich dem BZSt.{" "}
            <Link
              to="/umsatzsteuer/zm/$quartal"
              params={{
                quartal: periodKey({ year: data.period.year, month: data.period.month >= 41 ? data.period.month : quarterOfMonth(data.period.month) }),
              }}
            >
              Zur Zusammenfassenden Meldung
            </Link>
          </span>
        </div>
      )}

      {/* key: Formular bei Zeitraum- oder Anmeldungswechsel neu aufsetzen */}
      <VatReturnEditor key={`${key}-${data.current?.id ?? "neu"}-${data.current?.updatedAt ?? ""}`} data={data} notice={notice} setNotice={setNotice} />
      {/* Außerhalb des Editors: der baut sich nach jedem Speichern der Anmeldung neu auf und verwürfe sonst die Auswahl hier */}
      <div className="grid-main" style={{ marginTop: 16 }}>
        <VatFrequencyCard key={data.frequency.year} frequency={data.frequency} />
        <DauerfristCard key={`dauerfrist-${data.dauerfrist.year}`} overview={data.dauerfrist} setup={data} />
      </div>
    </>
  );
}

function VatReturnEditor({ data, notice, setNotice }: { data: PageData; notice: Notice; setNotice: (notice: Notice) => void }) {
  const current = data.current;
  const locked = current?.status === "sent";
  // Kz 39: die Sondervorauszahlung, abgezogen in der letzten Voranmeldung des Jahres
  const computed = computeUstva({ ...data.figures, kz39: data.kz39 });
  const [mode, setMode] = useState<"berechnet" | "manuell">(current?.source === "manuell" ? "manuell" : "berechnet");
  const [values, setValues] = useState<Record<FieldKey, string>>(
    () => Object.fromEntries(FIELDS.map((f) => [f, formatDecimal(current?.source === "manuell" ? current[f] : computed[f])])) as Record<FieldKey, string>,
  );
  const [reason, setReason] = useState(current?.overrideReason ?? "");
  const [openSources, setOpenSources] = useState<string | null>(null);
  const toggleSources = (kz: string) => setOpenSources((open) => (open === kz ? null : kz));
  const [dirty, setDirty] = useState(!current);

  const parsed = Object.fromEntries(FIELDS.map((f) => [f, parseEuro(values[f])])) as Record<FieldKey, number | null>;
  const manualFigures = Object.fromEntries(FIELDS.map((f) => [f, parsed[f] ?? 0])) as Record<FieldKey, number>;
  const allowed = anmeldbar(data);
  const shown = locked ? computeUstva(current!) : mode === "manuell" ? computeUstva(manualFigures) : computed;
  // Gespeicherter berechneter Entwurf, dessen Werte sich inzwischen geändert haben
  const stale = !locked && current?.source === "berechnet" && !sameFigures(current, computed);

  // Gesendete Anmeldung, deren Buchungen sich danach geändert haben (z. B. Zuordnung aufgehoben)
  const sentBasis = locked ? (current!.source === "berechnet" ? current! : current!.computed) : null;
  const drift = sentBasis !== null && sentBasis !== undefined && seitGesendetGeaendert(sentBasis, computed, data);

  function update(field: FieldKey, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    setDirty(true);
  }

  function switchMode(next: "berechnet" | "manuell") {
    setMode(next);
    setDirty(true);
  }

  const { busy, onSave, onSubmit, onCorrect } = useVoranmeldungAktionen(data, { mode, manualFigures, reason, dirty, setDirty }, setNotice);
  // Prüfung beim Speichern statt gesperrtem Knopf (#1270)
  const { pruefung, check, speichern } = usePruefungBeimSpeichern(parsed, reason, mode, onSave);

  const editable = !locked && mode === "manuell";

  return (
    <div className="grid-main">
      <form ref={pruefung.form} noValidate className="card" onSubmit={speichern} aria-labelledby="kz-heading">
        <h2 id="kz-heading">Kennzahlen</h2>
        {data.kleinunternehmer && (
          <div className="banner banner-info" role="status">
            <Icon name="info" />
            <span>
              Du bist als Kleinunternehmer (§ 19 UStG) eingetragen und gibst in der Regel keine Voranmeldung ab. Nötig ist sie nur, wenn du selbst Steuer
              schuldest, etwa für Leistungen ausländischer Unternehmer an dich (Reverse Charge).
            </span>
          </div>
        )}
        {!locked && (
          <div className="mode-switch" role="group" aria-label="Herkunft der Kennzahlen">
            <button
              type="button"
              className={`chip${mode === "berechnet" ? " active" : ""}`}
              aria-pressed={mode === "berechnet"}
              onClick={() => switchMode("berechnet")}
            >
              Aus Buchungen berechnet
            </button>
            <button
              type="button"
              className={`chip${mode === "manuell" ? " active" : ""}`}
              aria-pressed={mode === "manuell"}
              onClick={() => switchMode("manuell")}
            >
              Manuell überschreiben
            </button>
          </div>
        )}
        {drift && (
          <div className="banner" role="alert">
            Seit der Übermittlung haben sich die Buchungen dieses Monats geändert. Aus den Buchungen ergäben sich jetzt {describe(computed)}. Prüfe die Änderung
            und lege bei Bedarf eine berichtigte Anmeldung an.
          </div>
        )}
        <JournalVergleich year={data.period.year} uebernommen={data.uebernommen} current={current} returns={data.returns} journal={computed} />
        {stale && mode === "berechnet" && (
          <div className="banner banner-info" role="status">
            Die Buchungen haben sich seit dem Speichern geändert; angezeigt sind die aktuellen Werte. Beim Senden werden sie übernommen.
          </div>
        )}
        <p className="small muted" style={{ margin: 0 }}>
          Kz = Kennzahl, die Nummer des Felds im ELSTER-Formular.
        </p>
        <KennzahlenTabelle
          data={data}
          shown={shown}
          computed={computed}
          eingabe={{ locked, editable, values, fehler: (f) => pruefung.error(f), update, openSources, toggleSources }}
        />
        {editable && (
          <Field
            label="Begründung der Abweichung (Pflicht)"
            hint={<>Mindestens 10 Zeichen. Berechnet wären {describe(computed)}.</>}
            error={pruefung.error("reason")}
          >
            {(control) => (
              <textarea
                {...control}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  setDirty(true);
                }}
                maxLength={1000}
                placeholder="z. B. Zahlung vom 30.09. erst im Oktober zugeordnet"
              />
            )}
          </Field>
        )}
        {locked && current?.source === "manuell" && current.overrideReason && (
          <p className="small muted" style={{ margin: 0 }}>
            Manuell überschrieben: {current.overrideReason}
          </p>
        )}
        <p id="kz-hint" className="small muted" style={{ margin: 0 }}>
          Bemessungsgrundlagen meldet ELSTER in vollen Euro; Cent werden abgeschnitten.{" "}
          {data.figures.versteuerung === "ist"
            ? "Versteuerung nach vereinnahmten Entgelten (Ist): Umsatzsteuer nach Zahlungseingang, Vorsteuer nach Belegdatum."
            : "Versteuerung nach vereinbarten Entgelten (Soll): Umsatzsteuer nach Rechnungsdatum, Vorsteuer nach Belegdatum."}{" "}
          Fällig am {formatLongDate(data.dueDate)}.
        </p>
        {!locked && (
          <div className="actions">
            <button type="submit" className="btn" disabled={busy || !allowed || (!dirty && Boolean(current) && !stale)}>
              Entwurf speichern
            </button>
            {current && !dirty && !stale && data.companyIssues.length === 0 && (
              <a className="btn" href={`/api/ustva/${current.id}`} download>
                XML für Mein ELSTER
              </a>
            )}
          </div>
        )}
        {locked && (
          <div className="actions">
            <button type="button" className="btn" onClick={onCorrect} disabled={busy}>
              Berichtigte Anmeldung anlegen
            </button>
          </div>
        )}
        <NoticeBanner notice={notice} />
      </form>

      <AbgabeSpalte data={data} locked={locked} check={check} busy={busy} shown={shown} dirty={dirty} stale={stale} onSubmit={onSubmit} setNotice={setNotice} />
    </div>
  );
}
