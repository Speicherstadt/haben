import { periodKey, quarterOfMonth } from "@haben/core";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { EricHinweis } from "../../../components/EricHinweis.tsx";
import { Icon } from "../../../components/Icon.tsx";
import type { PageData } from "./-zeitraum-quellen.tsx";

const ELSTER_ABGABE_DOCS = "https://haben.app/elster-abgabe.html";

const ZIEL = { "/bank": "Zur Bank", "/belege": "Zu den Belegen", "/rechnungen": "Zu den Rechnungen", "/konten": "Zu den Konten" } as const;

/**
 * Die Hinweise über den Kennzahlen (#1253). Was das Senden hindert oder Zahlen verfälscht, bleibt je ein eigener Hinweis:
 * Zeitraum, Firmendaten und die Warnungen der Vorprüfung. Die Einrichtung (ERiC, Hersteller-ID) steht für sich, die
 * Hersteller-ID in einem Satz. Die übrigen Hinweise mit Link, die der Vorprüfung ohne Warnung und der Verweis auf die
 * Zusammenfassende Meldung, stehen gebündelt in einem Hinweis.
 */
export function ZeitraumHinweise({ data }: { data: PageData }) {
  const offen = data.current?.status !== "sent";
  const vorpruefung = offen ? data.preflight : [];
  const mitLink = (issue: PageData["preflight"][number]) => (
    <>
      {issue.text} <Link to={issue.link}>{ZIEL[issue.link]}</Link>
    </>
  );
  const ruhig: { key: string; inhalt: ReactNode }[] = vorpruefung
    .filter((issue) => issue.tone === "info")
    .map((issue) => ({ key: issue.text, inhalt: mitLink(issue) }));
  if (data.figures.kz21 !== 0 || data.figures.kz41 !== 0) {
    ruhig.push({
      key: "zm",
      inhalt: (
        <>
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
        </>
      ),
    });
  }
  return (
    <>
      {data.mode === "simuliert" && <EricHinweis />}
      {!data.herstellerIdConfigured && offen && (
        <div className="banner banner-info" role="status">
          <Icon name="info" />
          <span>
            Ohne eigene Hersteller-ID gibst du in Mein ELSTER ab: Entwurf speichern, „XML für Mein ELSTER“ herunterladen und dort im Formular
            Umsatzsteuer-Voranmeldung unter Datenübernahme › XML-Import hochladen.{" "}
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
      {vorpruefung
        .filter((issue) => issue.tone === "warn")
        .map((issue) => (
          <div key={issue.text} className="banner" role="status">
            <Icon name="alert" />
            <span>{mitLink(issue)}</span>
          </div>
        ))}
      {ruhig.length > 0 && (
        <div className="banner banner-info" role="status">
          <Icon name="info" />
          {ruhig.length === 1 ? (
            <span>{ruhig[0]?.inhalt}</span>
          ) : (
            <ul className="banner-list">
              {ruhig.map((hinweis) => (
                <li key={hinweis.key}>{hinweis.inhalt}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
