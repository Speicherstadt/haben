import { BESCHAEFTIGUNGSARTEN, KONFESSIONEN, type Beschaeftigungsart, type Konfession } from "@haben/core";
import { type ReactNode, useId } from "react";
import { Field } from "./Field.tsx";
import type { MitarbeiterFeld, MitarbeiterWerte, Texte } from "./mitarbeiter-pruefung.ts";

/* Die Abschnitte des Mitarbeiterformulars (MitarbeiterForm); jedes Feld mit Meldung trägt seinen Schlüssel aus mitarbeiter-pruefung.ts */

type Eingabe = { value: string; onChange: (e: { target: { value: string } }) => void };

/** Felder, die als Text direkt in den Werten stehen */
type TextFeld =
  | "vorname"
  | "nachname"
  | "strasse"
  | "plz"
  | "ort"
  | "steuerId"
  | "krankenkasse"
  | "krankenkasseBetriebsnummer"
  | "personengruppe"
  | "beitragsgruppen"
  | "taetigkeitsschluessel"
  | "svNummer"
  | "iban";

export interface AbschnittProps {
  w: MitarbeiterWerte;
  set: <K extends keyof MitarbeiterWerte>(key: K, value: MitarbeiterWerte[K]) => void;
  /** Felder, die erst beim Speichern gelesen werden (Beträge, Sätze, Zahlen) */
  text: (key: keyof Texte) => Eingabe;
  feld: (key: TextFeld) => Eingabe;
  error: (key: MitarbeiterFeld) => string | undefined;
}

const STEUERKLASSEN = ["I", "II", "III", "IV", "V", "VI"];

function Abschnitt({ titel, children }: { titel: string; children: ReactNode }) {
  return (
    <fieldset className="form-section">
      <legend>{titel}</legend>
      {children}
    </fieldset>
  );
}

export function Person({ w, set, feld, error }: AbschnittProps) {
  return (
    <Abschnitt titel="Person">
      <div className="form-row cols-2">
        <Field label="Vorname" error={error("vorname")}>
          {(control) => <input {...control} {...feld("vorname")} required maxLength={100} autoComplete="off" />}
        </Field>
        <Field label="Nachname" error={error("nachname")}>
          {(control) => <input {...control} {...feld("nachname")} required maxLength={100} autoComplete="off" />}
        </Field>
      </div>
      <Field label="Straße und Hausnummer">{(control) => <input {...control} {...feld("strasse")} maxLength={200} autoComplete="off" />}</Field>
      <div className="form-row cols-place">
        <Field label="PLZ">{(control) => <input {...control} {...feld("plz")} inputMode="numeric" maxLength={10} autoComplete="off" />}</Field>
        <Field label="Ort">{(control) => <input {...control} {...feld("ort")} maxLength={100} autoComplete="off" />}</Field>
        <Field label="Geburtsdatum" error={error("geburtsdatum")}>
          {(control) => <input {...control} type="date" value={w.geburtsdatum} onChange={(e) => set("geburtsdatum", e.target.value)} required />}
        </Field>
      </div>
      <Field label="IBAN für die Auszahlung" error={error("iban")}>
        {(control) => <input {...control} {...feld("iban")} className="mono" autoComplete="off" />}
      </Field>
    </Abschnitt>
  );
}

export function Beschaeftigung({ w, set, text, error, arten }: AbschnittProps & { arten: readonly Beschaeftigungsart[] }) {
  return (
    <Abschnitt titel="Beschäftigung">
      <div className="form-row cols-2">
        <Field label="Art der Beschäftigung">
          {(control) => (
            <select {...control} value={w.art} onChange={(e) => set("art", e.target.value as Beschaeftigungsart)}>
              {arten.map((key) => (
                <option key={key} value={key}>
                  {BESCHAEFTIGUNGSARTEN[key]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Monatsgehalt brutto in Euro" error={error("monatsgehalt")}>
          {(control) => <input {...control} {...text("monatsgehalt")} inputMode="decimal" placeholder="0,00" required />}
        </Field>
        <Field label="Eintritt" error={error("eintritt")}>
          {(control) => <input {...control} type="date" value={w.eintritt} onChange={(e) => set("eintritt", e.target.value)} required />}
        </Field>
        <Field label="Austritt (optional)" error={error("austritt")}>
          {(control) => <input {...control} type="date" value={w.austritt ?? ""} onChange={(e) => set("austritt", e.target.value || null)} />}
        </Field>
      </div>
      {w.art === "beschaeftigt" && (
        <p className="field-hint">
          Abrechnungen mit Sozialversicherung sind ein Entwurf zum Gegenprüfen, bis ein echter Fall gegen ein Lohnprogramm gerechnet ist.
        </p>
      )}
      {w.art === "ggf" && (
        <Field label="Statusfeststellung (§ 7a SGB IV)">
          {(control) => (
            <select
              {...control}
              value={w.statusfeststellung}
              onChange={(e) => set("statusfeststellung", e.target.value as MitarbeiterWerte["statusfeststellung"])}
            >
              <option value="">noch nicht beantragt</option>
              <option value="beantragt">beantragt, noch kein Ergebnis</option>
              <option value="versicherungsfrei">versicherungsfrei festgestellt</option>
              <option value="versicherungspflichtig">versicherungspflichtig festgestellt</option>
            </select>
          )}
        </Field>
      )}
    </Abschnitt>
  );
}

export function Lohnsteuermerkmale({ w, set, text, feld, error }: AbschnittProps) {
  return (
    <Abschnitt titel="Lohnsteuerabzugsmerkmale (ELStAM)">
      <div className="form-row cols-2">
        <Field label="Steuer-ID" error={error("steuerId")}>
          {(control) => <input {...control} {...feld("steuerId")} inputMode="numeric" className="mono" autoComplete="off" />}
        </Field>
        <Field label="Steuerklasse">
          {(control) => (
            <select {...control} value={w.steuerklasse} onChange={(e) => set("steuerklasse", Number(e.target.value))}>
              {STEUERKLASSEN.map((k, i) => (
                <option key={k} value={i + 1}>
                  {k}
                </option>
              ))}
            </select>
          )}
        </Field>
        {w.steuerklasse === 4 && (
          <Field label="Faktor (Steuerklasse IV)" error={error("faktor")}>
            {(control) => <input {...control} {...text("faktor")} inputMode="decimal" />}
          </Field>
        )}
        <Field label="Kinderfreibeträge" error={error("kinderfreibetraege")}>
          {(control) => <input {...control} {...text("kinderfreibetraege")} inputMode="decimal" />}
        </Field>
        <Field label="Kirchensteuermerkmal">
          {(control) => (
            <select {...control} value={w.konfession ?? ""} onChange={(e) => set("konfession", (e.target.value || null) as Konfession | null)}>
              <option value="">keine Kirchensteuer</option>
              {Object.entries(KONFESSIONEN).map(([key, label]) => (
                <option key={key} value={key}>
                  {key} – {label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
    </Abschnitt>
  );
}

/** Kontrollkästchen ohne Field mit Meldung darunter (DESIGN.md, Gesperrte Knöpfe): aria-invalid, damit der Fokus es findet */
function Zuschlag({ w, set, error }: AbschnittProps) {
  const fehlerId = useId();
  const fehler = error("kinderlosenzuschlag");
  return (
    <div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={w.kinderlosenzuschlag}
          onChange={(e) => set("kinderlosenzuschlag", e.target.checked)}
          aria-invalid={fehler ? true : undefined}
          aria-describedby={fehler ? fehlerId : undefined}
        />
        Zuschlag für Kinderlose (ab 23 Jahren ohne Elterneigenschaft)
      </label>
      {fehler && (
        <span id={fehlerId} className="field-error">
          {fehler}
        </span>
      )}
    </div>
  );
}

export function KrankenPflege(props: AbschnittProps) {
  const { w, set, text, feld, error } = props;
  return (
    <Abschnitt titel="Kranken- und Pflegeversicherung">
      <div className="form-row cols-2">
        <Field label="Krankenversicherung">
          {(control) => (
            <select {...control} value={w.krankenversicherung} onChange={(e) => set("krankenversicherung", e.target.value as "gesetzlich" | "privat")}>
              <option value="gesetzlich">gesetzlich</option>
              <option value="privat">privat</option>
            </select>
          )}
        </Field>
        {w.krankenversicherung === "gesetzlich" ? (
          <Field label="Zusatzbeitrag der Kasse in Prozent" error={error("zusatzbeitrag")}>
            {(control) => <input {...control} {...text("zusatzbeitrag")} inputMode="decimal" />}
          </Field>
        ) : (
          <>
            <Field label="Basisbeitrag im Monat in Euro" hint="Basiskranken- und Pflegeversicherung" error={error("pkvBasisbeitrag")}>
              {(control) => <input {...control} {...text("pkvBasisbeitrag")} inputMode="decimal" />}
            </Field>
            <Field label="Zuschuss des Arbeitgebers im Monat in Euro" error={error("pkvZuschuss")}>
              {(control) => <input {...control} {...text("pkvZuschuss")} inputMode="decimal" />}
            </Field>
          </>
        )}
        <Field label="Kinder unter 25" error={error("kinderUnter25")}>
          {(control) => <input {...control} {...text("kinderUnter25")} inputMode="numeric" />}
        </Field>
      </div>
      <Zuschlag {...props} />
      {w.art === "beschaeftigt" && (
        <div className="form-row cols-2">
          <Field label="Krankenkasse">{(control) => <input {...control} {...feld("krankenkasse")} maxLength={100} autoComplete="off" />}</Field>
          <Field label="Betriebsnummer der Krankenkasse" error={error("krankenkasseBetriebsnummer")}>
            {(control) => <input {...control} {...feld("krankenkasseBetriebsnummer")} inputMode="numeric" className="mono" autoComplete="off" />}
          </Field>
          <Field label="Umlage U1 in Prozent" hint="Leer ohne Teilnahme am U1-Verfahren" error={error("u1Satz")}>
            {(control) => <input {...control} {...text("u1Satz")} inputMode="decimal" />}
          </Field>
          <Field label="Umlage U2 in Prozent" error={error("u2Satz")}>
            {(control) => <input {...control} {...text("u2Satz")} inputMode="decimal" />}
          </Field>
        </div>
      )}
    </Abschnitt>
  );
}

export function Meldedaten({ w, set, feld, error }: AbschnittProps) {
  const minijob = w.art === "minijob";
  return (
    <Abschnitt titel="Meldedaten der Sozialversicherung">
      <div className="form-row cols-2">
        <Field label="Versicherungsnummer" error={error("svNummer")}>
          {(control) => <input {...control} {...feld("svNummer")} className="mono uppercase" autoComplete="off" />}
        </Field>
        <Field label="Personengruppe" error={error("personengruppe")}>
          {(control) => <input {...control} {...feld("personengruppe")} inputMode="numeric" className="mono" placeholder={minijob ? "109" : "101"} />}
        </Field>
        <Field label="Beitragsgruppenschlüssel" error={error("beitragsgruppen")}>
          {(control) => <input {...control} {...feld("beitragsgruppen")} inputMode="numeric" className="mono" placeholder={minijob ? "6500" : "1111"} />}
        </Field>
        <Field label="Tätigkeitsschlüssel" error={error("taetigkeitsschluessel")}>
          {(control) => <input {...control} {...feld("taetigkeitsschluessel")} inputMode="numeric" className="mono" />}
        </Field>
      </div>
      {minijob && (
        <>
          <label className="checkbox">
            <input type="checkbox" checked={w.pauschsteuer} onChange={(e) => set("pauschsteuer", e.target.checked)} />
            Pauschsteuer 2 % (§ 40a Abs. 2 EStG), trägt der Arbeitgeber
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={w.rvBefreit} onChange={(e) => set("rvBefreit", e.target.checked)} />
            Von der Rentenversicherungspflicht befreit
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={w.u1Satz !== null} onChange={(e) => set("u1Satz", e.target.checked ? 0 : null)} />
            Arbeitgeber nimmt am U1-Verfahren teil (Sätze der Minijob-Zentrale)
          </label>
        </>
      )}
    </Abschnitt>
  );
}
